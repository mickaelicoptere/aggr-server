const Influx = require('influx')
const { getHms, sleep, ID } = require('../helper')
const net = require('net')
const config = require('../config')
const socketService = require('../services/socket')
const alertService = require('../services/alert')
const { connections, updateIndexes } = require('../services/connections')

require('../typedef')

const DAY = 1000 * 60 * 60 * 24

class InfluxStorage {
  constructor() {
    this.name = this.constructor.name
    this.format = 'point'

    /**
     * @type {{[pendingBarsRequestId: string]: (bars: Bar[]) => void}}
     */
    this.promisesOfPendingBars = {}

    /**
     * @type {{[identifier: string]: Bar[]}}
     */
    this.recentlyClosedBars = {}

    /**
     * @type {{[identifier: string]: Bar[]}}
     */
    this.pendingBars = {}

    /**
     * @type {{[identifier: string]: any[]}}
     */
    this.alerts = {}

    /**
     * @type {{[endpoint: string]: any}}
     */
    this.alertEndpoints = {}
  }

  async connect() {
    if (/\-/.test(config.influxDatabase)) {
      throw new Error('dashes not allowed inside influxdb database')
    }

    let host = config.influxHost
    let port = config.influxPort

    if (typeof config.influxUrl === 'string' && config.influxUrl.length) {
      ;[host, port] = config.influxUrl.split(':')
    }

    console.log(`[storage/influx] connecting to ${host}:${port} on db "${config.influxDatabase}"`)

    try {
      this.influx = new Influx.InfluxDB({
        host: host || 'localhost',
        port: port || '8086',
        database: config.influxDatabase,
      })

      const databases = await this.influx.getDatabaseNames()

      if (!databases.includes(config.influxDatabase)) {
        await this.influx.createDatabase(config.influxDatabase)
      }

      if (config.collect) {
        await this.ensureRetentionPolicies()
        await this.getPreviousBars()
      }
    } catch (error) {
      console.error(`[storage/influx] ${error.message}... retrying in 1s`)

      await sleep()

      return this.connect()
    } finally {
      if (config.influxCollectors) {
        if (config.api) {
          this.bindCollectorsEvents()
        } else if (config.collect) {
          this.bindClusterEvents()
        }

        if (config.api && !config.collect) {
          // schedule import of all collectors every influxResampleInterval until the scripts die
          setTimeout(this.importCollectors.bind(this), config.influxResampleInterval)
        }
      }

      if (alertService) {
        this.bindAlertsEvents()
      }
    }
  }

  /**
   * listen for responses from collector node
   */
  bindCollectorsEvents() {
    socketService
      .on('import', () => {
        // response from import request

        if (this.promiseOfImport) {
          this.promiseOfImport() // trigger next import (if any)
        }
      })
      .on('requestPendingBars', (data) => {
        // response from pending bars request

        if (this.promisesOfPendingBars[data.pendingBarsRequestId]) {
          this.promisesOfPendingBars[data.pendingBarsRequestId](data.results)
        } else {
          console.error('[influx/cluster] there was no promisesOfPendingBars with given pendingBarsRequestId', data.pendingBarsRequestId)
        }
      })
  }

  /**
   * listen for request from cluster node
   */
  bindClusterEvents() {
    socketService
      .on('requestPendingBars', (data) => {
        // this is a request for pending bars from cluster
        const payload = {
          pendingBarsRequestId: data.pendingBarsRequestId,
          results: this.getPendingBars(data.markets, data.from, data.to),
        }

        socketService.clusterSocket.write(
          JSON.stringify({
            op: 'requestPendingBars',
            data: payload,
          }) + '#'
        )
      })
      .on('import', () => {
        // this is a request to import pending data

        this.import().finally(() => {
          if (socketService.clusterSocket) {
            socketService.clusterSocket.write(
              JSON.stringify({
                op: 'import',
              }) + '#'
            )
          }
        })
      })
  }

  /**
   * Listen for alerts change
   */
  bindAlertsEvents() {
    alertService.on('change', ({ market, price, user, type, previousPrice }) => {
      const fields = {
        price,
        user,
        type,
      }

      if (typeof previousPrice !== 'undefined') {
        fields.previousPrice = previousPrice
      }

      this.writePoints(
        [
          {
            measurement: 'alerts',
            tags: {
              market,
            },
            fields,
            timestamp: Date.now(),
          },
        ],
        {
          precision: 'ms',
        }
      )
    })
  }

  /**
   *
   */
  async ensureRetentionPolicies() {
    const retentionsPolicies = (await this.influx.showRetentionPolicies()).reduce((output, retentionPolicy) => {
      output[retentionPolicy.name] = retentionPolicy.duration
      return output
    }, {})

    const timeframes = [config.influxTimeframe].concat(config.influxResampleTo)

    for (let timeframe of timeframes) {
      const rpDuration = timeframe * config.influxRetentionPerTimeframe
      const rpDurationLitteral = getHms(rpDuration, true)
      const rpName = config.influxRetentionPrefix + getHms(timeframe)

      if (!retentionsPolicies[rpName]) {
        console.log(`[storage/influx] create retention policy ${rpName} (duration ${rpDurationLitteral})`)
        await this.influx.createRetentionPolicy(rpName, {
          database: config.influxDatabase,
          duration: rpDurationLitteral,
          replication: 1,
        })
      }

      delete retentionsPolicies[rpName]
    }

    for (let rpName in retentionsPolicies) {
      if (rpName.indexOf(config.influxRetentionPrefix) === 0) {
        console.warn(`[storage/influx] unused retention policy ? (${rpName})`)
        // await this.influx.dropRetentionPolicy(rpName, config.influxDatabase)
        // just warning now because of multiple instances of aggr-server running with different RPs
      }
    }

    this.baseRp = config.influxRetentionPrefix + getHms(config.influxTimeframe)
  }

  getPreviousBars() {
    const timeframeLitteral = getHms(config.influxTimeframe)
    const now = +new Date()

    let query = `SELECT * FROM ${config.influxRetentionPrefix}${timeframeLitteral}.${config.influxMeasurement}${'_' + timeframeLitteral}`

    query += ` WHERE (${config.pairs.map((market) => `market = '${market}'`).join(' OR ')})`

    query += `GROUP BY "market" ORDER BY time DESC LIMIT 1`

    this.influx.query(query).then((data) => {
      for (let bar of data) {
        if (now - bar.time > config.influxResampleInterval) {
          console.log(`[getLastBars] can't use lastBar because it is too old anyway (closed ${getHms(now - bar.time)}) ago`)
          continue
        }

        let originalBar

        if (!this.pendingBars[bar.market]) {
          this.pendingBars[bar.market] = []
        }

        if (this.pendingBars[bar.market] && (originalBar = this.pendingBars[bar.market].find(({ time }) => bar.time == time))) {
          this.sumBar(originalBar, bar)
        } else {
          this.pendingBars[bar.market].push(this.sumBar({}, bar))
        }
      }
    })
  }

  sumBar(barToMutate, barToAdd) {
    const props = Object.keys(barToMutate)
      .concat(Object.keys(barToAdd))
      .filter((x, i, a) => a.indexOf(x) == i)

    for (let i = 0; i < props.length; i++) {
      const prop = props[i]

      const value = isNaN(barToAdd[prop]) ? barToAdd[prop] : +barToAdd[prop]

      if (typeof barToMutate[prop] === 'undefined') {
        barToMutate[prop] = value
        continue
      }

      if (typeof barToMutate[prop] === 'number') {
        barToMutate[props] += value
      }
    }

    return barToMutate
  }

  /**
   * Process the trades into bars of minimum tf
   * And occasionaly writes into db
   * Triggered every options.backupInterval
   *
   * @param {Trade[]} trades
   * @param {boolean} isExiting
   * @returns
   */
  async save(trades, isExiting) {
    if (!trades || !trades.length) {
      return Promise.resolve()
    }

    // convert the trades into bars (bars tf = minimum tf)
    this.processTrades(trades)

    if (isExiting) {
      // always write when exiting
      return this.import()
    }

    if (!socketService.clusterSocket) {
      // here the cluster node decide when to write in db
      // otherwise cluster will send a command for that (to balance write tasks between collectors nodes)

      const now = Date.now()
      const timeBackupFloored = Math.floor(now / config.backupInterval) * config.backupInterval
      const timeMinuteFloored = Math.floor(now / config.influxResampleInterval) * config.influxResampleInterval

      if (timeBackupFloored === timeMinuteFloored) {
        return this.import()
      }
    }
  }

  /**
   * close a bar (register close + reference for next bar)
   * @param {Bar} bar
   */
  closeBar(bar) {
    if (typeof bar.close === 'number') {
      // reg range for index
      connections[bar.market].high = Math.max(connections[bar.market].high, bar.high)
      connections[bar.market].low = Math.min(connections[bar.market].low, bar.low)
    }

    connections[bar.market].bar = bar

    return connections[bar.market].bar
  }

  /**
   * Trades into bars (pending bars)
   *
   * @param {Trade[]} trades
   * @returns {Promise<{
      from: number,
      to: number,
      markets: string[],
    }>}
   * @memberof InfluxStorage
   */
  async processTrades(trades) {
    /**
     * Current bars
     * @type {{[identifier: string]: Bar}}
     */
    const activeBars = {}

    for (let i = 0; i <= trades.length; i++) {
      const trade = trades[i]

      let market
      let tradeFlooredTime

      if (!trade) {
        // end of loop reached = close all bars
        for (let barIdentifier in activeBars) {
          if (!activeBars[barIdentifier]) {
            console.error('active bar undefined (wont close bar)', barIdentifier)
          } else {
            this.closeBar(activeBars[barIdentifier])
          }

          delete activeBars[barIdentifier]
        }

        break
      } else {
        market = trade.exchange + ':' + trade.pair

        tradeFlooredTime = Math.floor(trade.timestamp / config.influxTimeframe) * config.influxTimeframe

        if (connections[market].bar && tradeFlooredTime < connections[market].bar.time) {
          tradeFlooredTime = connections[market].bar.time
        }

        if (!activeBars[market] || activeBars[market].time < tradeFlooredTime) {
          if (activeBars[market]) {
            if (!activeBars[market]) {
              console.error('active bar undefined (wont close bar)', market)
            } else {
              // close bar required
              this.closeBar(activeBars[market])
            }

            delete activeBars[market]
          } else {
            connections[market].high = -Infinity
            connections[market].low = Infinity
          }

          // create bar required
          if (!this.pendingBars[market]) {
            this.pendingBars[market] = []
          }

          if (this.pendingBars[market].length && this.pendingBars[market][this.pendingBars[market].length - 1].time === tradeFlooredTime) {
            activeBars[market] = this.pendingBars[market][this.pendingBars[market].length - 1]
            // console.log(`use last pending bar (time ${new Date(activeBars[market].time).toISOString().split('T').pop()}`)
          } else if (connections[market].bar && connections[market].bar.time === tradeFlooredTime) {
            // trades passed in save() contains some of the last batch (trade time = last bar time)
            // recover exchange point of lastbar
            this.pendingBars[market].push(connections[market].bar)
            activeBars[market] = this.pendingBars[market][this.pendingBars[market].length - 1]
            // console.log(`use connection bar (time ${new Date(activeBars[market].time).toISOString().split('T').pop()}`)
          } else if (
            !this.pendingBars[market].length ||
            !(activeBars[market] = this.pendingBars[market].find((a) => a.time === tradeFlooredTime))
          ) {
            // onsole.log(`create empty bar (time ${new Date(tradeFlooredTime).toISOString().split('T').pop()}`)
            // create new bar

            this.pendingBars[market].push({
              time: tradeFlooredTime,
              market: market,
              cbuy: 0,
              csell: 0,
              vbuy: 0,
              vsell: 0,
              lbuy: 0,
              lsell: 0,
              open: null,
              high: null,
              low: null,
              close: null,
            })

            activeBars[market] = this.pendingBars[market][this.pendingBars[market].length - 1]
          } /* else {
            console.log(`use pending bar at index ${this.pendingBars[market].indexOf(activeBars[market])} (time ${new Date(activeBars[market].time).toISOString().split('T').pop()}`)
          }*/
        }
      }

      if (trade.liquidation) {
        // trade is a liquidation
        activeBars[market]['l' + trade.side] += trade.price * trade.size
      } else {
        if (activeBars[market].open === null) {
          // new bar without close in db, should only happen once
          activeBars[market].open = activeBars[market].high = activeBars[market].low = activeBars[market].close = +trade.price
        }

        activeBars[market].high = Math.max(activeBars[market].high, +trade.price)
        activeBars[market].low = Math.min(activeBars[market].low, +trade.price)
        activeBars[market].close = +trade.price

        activeBars[market]['c' + trade.side] += trade.count || 1
        activeBars[market]['v' + trade.side] += trade.price * trade.size
      }
    }

    updateIndexes((index, high, low) => {
      alertService.checkPriceCrossover(index, high, low)
    })
  }

  /**
   * Import pending bars (minimum tf bars) and resample into bigger timeframes
   */
  async import() {
    const resampleRange = await this.importPendingBars()

    if (resampleRange.to - resampleRange.from >= 0) {
      await this.resample(resampleRange)
    }
  }

  /**
   * Import and clear pending bars
   *
   * @returns {Promise<{
      from: number,
      to: number,
      markets: string[],
    }>}
   * @memberof InfluxStorage
   */
  async importPendingBars() {
    /**
     * closed bars
     * @type {Bar[]}
     */
    const barsToImport = []

    /**
     * Total range of import
     * @type {TimeRange}
     */
    const importedRange = {
      from: Infinity,
      to: 0,
      markets: [],
    }

    for (const identifier in this.pendingBars) {
      for (let i = 0; i < this.pendingBars[identifier].length; i++) {
        const bar = this.pendingBars[identifier][i]

        importedRange.from = Math.min(bar.time, importedRange.from)
        importedRange.to = Math.max(bar.time, importedRange.to)

        if (importedRange.markets.indexOf(identifier) === -1) {
          importedRange.markets.push(identifier)
        }

        barsToImport.push(this.pendingBars[identifier].shift())
        i--
      }
    }

    // free up realtime bars
    this.pendingBars = {}

    if (barsToImport.length) {
      await this.writePoints(
        barsToImport.map((bar) => {
          const fields = {}

          if (bar.vbuy || bar.vsell) {
            fields.vbuy = bar.vbuy
            fields.vsell = bar.vsell
            fields.cbuy = bar.cbuy
            fields.csell = bar.csell
          }

          if (bar.lbuy || bar.lsell) {
            fields.lbuy = bar.lbuy
            fields.lsell = bar.lsell
          }

          if (bar.close !== null) {
            ;(fields.open = bar.open), (fields.high = bar.high), (fields.low = bar.low), (fields.close = bar.close)
          }

          return {
            measurement: 'trades_' + getHms(config.influxTimeframe),
            tags: {
              market: bar.market,
            },
            fields: fields,
            timestamp: +bar.time,
          }
        }),
        {
          precision: 'ms',
          retentionPolicy: this.baseRp,
        }
      )
    }

    return importedRange
  }

  /**
   * Wrapper for write
   * Write points into db
   * Called from importPendingBars
   *
   * @param {Influx.IPoint[]} points
   * @param {Influx.IWriteOptions} options
   * @param {number?} attempt no of attempt starting at 0 (abort if too much failed attempts)
   * @returns
   */
  async writePoints(points, options, attempt = 0) {
    if (!points.length) {
      return
    }

    const measurement = points[0].measurement
    const from = points[0].timestamp
    const to = points[points.length - 1].timestamp

    try {
      await this.influx.writePoints(points, options)

      if (attempt > 0) {
        console.debug(`[storage/influx] successfully wrote points after ${attempt} attempt(s)`)
      }
    } catch (error) {
      attempt++

      console.error(
        `[storage/influx] write points failed (${attempt}${
          attempt === 1 ? 'st' : attempt === 2 ? 'nd' : attempt === 3 ? 'rd' : 'th'
        } attempt)`,
        error.message
      )

      if (attempt >= 5) {
        console.error(
          `too many attemps at writing points\n\n${measurement}, ${new Date(from).toUTCString()} to ${new Date(
            to
          ).toUTCString()}\n\t-> abort`
        )
        throw error.message
      }

      await sleep(500)

      return this.writePoints(points, options, attempt)
    }
  }

  /**
   * Start from minimum tf (influxTimeframe) and update all timeframes above it (influxResampleTo)
   * 10s into 30s, 30s into 1m, 1m into 3m, 1m into 5m, 5m into 15m, 3m into 21m, 15m into 30m etc
   *
   * @memberof InfluxStorage
   */
  async resample(range, fromTimeframe, toTimeframe = null) {
    let sourceTimeframeLitteral
    let destinationTimeframeLitteral

    let now = Date.now()
    let before = now

    console.debug(`[storage/influx/resample] resampling ${range.markets.length} markets`)

    let minimumTimeframe
    let timeframes
    if (fromTimeframe) {
      minimumTimeframe = Math.max(fromTimeframe, config.influxTimeframe)
      timeframes = config.influxResampleTo.filter((a) => a > fromTimeframe)
    } else {
      minimumTimeframe = config.influxTimeframe
      timeframes = config.influxResampleTo
    }

    let bars = 0

    for (let timeframe of timeframes) {
      const isOddTimeframe = DAY % timeframe !== 0 && timeframe < DAY

      if (toTimeframe && timeframe !== toTimeframe) {
        continue
      }

      let flooredRange

      if (isOddTimeframe) {
        const dayOpen = Math.floor(range.from / DAY) * DAY
        flooredRange = {
          from: dayOpen + Math.floor((range.from - dayOpen) / timeframe) * timeframe,
          to: dayOpen + Math.floor((range.to - dayOpen) / timeframe) * timeframe + timeframe,
        }
      } else {
        flooredRange = {
          from: Math.floor(range.from / timeframe) * timeframe,
          to: Math.floor(range.to / timeframe) * timeframe + timeframe,
        }
      }

      for (let i = timeframes.indexOf(timeframe); i >= 0; i--) {
        if (timeframe <= timeframes[i] || timeframe % timeframes[i] !== 0) {
          if (i === 0) {
            sourceTimeframeLitteral = getHms(minimumTimeframe)
          }
          continue
        }

        sourceTimeframeLitteral = getHms(timeframes[i])
        break
      }

      destinationTimeframeLitteral = getHms(timeframe)

      const query = `SELECT min(low) AS low, 
      max(high) AS high, 
      first(open) AS open, 
      last(close) AS close, 
      sum(count) AS count, 
      sum(cbuy) AS cbuy, 
      sum(csell) AS csell, 
      sum(lbuy) AS lbuy, 
      sum(lsell) AS lsell, 
      sum(vol) AS vol, 
      sum(vbuy) AS vbuy, 
      sum(vsell) AS vsell`

      const query_from = `${config.influxDatabase}.${config.influxRetentionPrefix}${sourceTimeframeLitteral}.${config.influxMeasurement}_${sourceTimeframeLitteral}`
      const query_into = `${config.influxDatabase}.${config.influxRetentionPrefix}${destinationTimeframeLitteral}.${config.influxMeasurement}_${destinationTimeframeLitteral}`

      let coverage = `WHERE time >= ${flooredRange.from}ms AND time < ${flooredRange.to}ms`
      coverage += ` AND (${range.markets.map((market) => `market = '${market}'`).join(' OR ')})`

      const group = `GROUP BY time(${destinationTimeframeLitteral}${
        isOddTimeframe ? ', ' + getHms(flooredRange.from % timeframe) : ''
      }), market fill(none)`

      bars += (flooredRange.to - flooredRange.from) / timeframe

      await this.executeQuery(`${query} INTO ${query_into} FROM ${query_from} ${coverage} ${group}`)
    }

    now = Date.now()

    console.debug(
      `[storage/influx/resample] done resampling ${parseInt((now - before) / bars)}ms per bar (${parseInt(
        now - before
      )}ms for ${bars} bars)`
    )
  }

  /**
   * Wrapper for query
   * Query the db
   * Called from resample
   *
   * @param {string} query
   * @param {number?} attempt no of attempt starting at 0 (abort if too much failed attempts)
   * @returns
   */
  async executeQuery(query, attempt = 0) {
    try {
      await this.influx.query(query)

      if (attempt > 0) {
        console.debug(`[storage/influx] successfully executed query ${attempt} attempt(s)`)
      }
    } catch (error) {
      attempt++

      console.error(
        `[storage/influx] query failed (${attempt}${attempt === 1 ? 'st' : attempt === 2 ? 'nd' : attempt === 3 ? 'rd' : 'th'} attempt)`,
        error.message
      )

      if (attempt >= 5) {
        console.error(`too many attemps at executing query\n\n${query}\n\t-> abort`)
        throw error.message
      }

      await sleep(500)

      return this.executeQuery(query, attempt)
    }
  }

  /**
   * Called from main
   * API user called method
   *
   * @returns
   */
  fetch({ from, to, timeframe = 60000, markets = [] }) {
    const timeframeLitteral = getHms(timeframe)

    let query = `SELECT * FROM "${config.influxDatabase}"."${config.influxRetentionPrefix}${timeframeLitteral}"."trades_${timeframeLitteral}" WHERE time >= ${from}ms AND time < ${to}ms`

    if (markets.length) {
      query += ` AND (${markets.map((market) => `market = '${market}'`).join(' OR ')})`
    }

    return this.influx
      .queryRaw(query, {
        precision: 's',
        epoch: 's',
      })
      .then((results) => {
        const output = {
          format: this.format,
          columns: {},
          results: [],
        }

        if (results.results[0].series && results.results[0].series[0].values.length) {
          output.columns = this.formatColumns(results.results[0].series[0].columns)
          output.results = results.results[0].series[0].values
        }

        if (to > +new Date() - config.influxResampleInterval) {
          return this.appendPendingBarsToResponse(output.results, markets, from, to).then((bars) => {
            output.results = bars
            return output
          })
        }

        return output
      })
      .catch((err) => {
        console.error(`[storage/influx] failed to retrieves trades between ${from} and ${to} with timeframe ${timeframe}\n\t`, err.message)
      })
  }

  /**
   * Concat given results of bars with realtime bars (pending bars)
   * If clustering enabled, use collectors as source of pending bars
   * Otherwise current node pending bars will be used
   * @param {number[][]} bars
   * @param {string[]} markets
   * @param {number} from
   * @param {number} to
   * @returns
   */
  appendPendingBarsToResponse(bars, markets, from, to) {
    if (config.influxCollectors && socketService.clusteredCollectors.length) {
      // use collectors nodes pending bars
      return this.requestPendingBars(markets, from, to).then((pendingBars) => {
        return bars.concat(pendingBars)
      })
    } else {
      // use current node pending bars
      let injectedPendingBars = []

      for (const market of markets) {
        if (this.pendingBars[market] && this.pendingBars[market].length) {
          for (const bar of this.pendingBars[market]) {
            if (bar.time >= from && bar.time < to && bar.close !== null) {
              injectedPendingBars.push(bar)
            }
          }
        }
      }

      injectedPendingBars = injectedPendingBars.sort((a, b) => a.time - b.time)

      return Promise.resolve(bars.concat(injectedPendingBars))
    }
  }
  async importCollectors() {
    for (const collector of socketService.clusteredCollectors) {
      await new Promise((resolve) => {
        let importTimeout = setTimeout(() => {
          console.error('[storage/influx/cluster] collector import was resolved early (5s timeout fired)')
          importTimeout = null
          resolve()
        }, 5000)

        this.promiseOfImport = () => {
          if (importTimeout) {
            clearTimeout(importTimeout)
            resolve()
          }
        }

        collector.write(JSON.stringify({ op: 'import' }) + '#')
      })
    }

    setTimeout(this.importCollectors.bind(this), config.influxResampleInterval)
  }

  /**
   * Called from the cluster node
   * Return array of realtime bars matching the given criteras (markets, start time & end time)
   * This WILL query all nodes responsible of collecting trades for given markets
   * @param {net.Socket} markets
   * @param {number} from
   * @param {number} to
   */
  async requestPendingBars(markets, from, to) {
    const collectors = []

    for (let i = 0; i < markets.length; i++) {
      for (let j = 0; j < socketService.clusteredCollectors.length; j++) {
        if (
          collectors.indexOf(socketService.clusteredCollectors[j]) === -1 &&
          socketService.clusteredCollectors[j].markets.indexOf(markets[i]) !== -1
        ) {
          collectors.push(socketService.clusteredCollectors[j])
        }
      }
    }

    const promisesOfBars = []

    for (const collector of collectors) {
      promisesOfBars.push(this.requestCollectorPendingBars(collector, markets, from, to))
    }

    return [].concat.apply([], await Promise.all(promisesOfBars)).sort((a, b) => a.time - b.time)
  }

  /**
   * Called from the cluster node
   * Query specific collector node (socket) for realtime bars matching given criteras
   * @param {net.Socket} collector
   * @param {string[]} markets
   * @param {number} from
   * @param {number} to
   */
  async requestCollectorPendingBars(collector, markets, from, to) {
    return new Promise((resolve) => {
      const pendingBarsRequestId = ID()

      let promiseOfPendingBarsTimeout = setTimeout(() => {
        console.error('[storage/influx/cluster] promise of realtime bar timeout fired (pendingBarsRequestId: ' + pendingBarsRequestId + ')')

        // response empty array as we didn't got the expected bars...
        this.promisesOfPendingBars[pendingBarsRequestId]([])

        // invalidate timeout
        promiseOfPendingBarsTimeout = null
      }, 5000)

      // register promise
      this.promisesOfPendingBars[pendingBarsRequestId] = (pendingBars) => {
        if (promiseOfPendingBarsTimeout) {
          clearTimeout(promiseOfPendingBarsTimeout)
        }

        // unregister promise
        delete this.promisesOfPendingBars[pendingBarsRequestId]

        resolve(pendingBars)
      }

      collector.write(
        JSON.stringify({
          op: 'requestPendingBars',
          data: {
            pendingBarsRequestId,
            markets,
            from,
            to,
          },
        }) + '#'
      )
    })
  }

  getPendingBars(markets, from, to) {
    const results = []

    for (const market of markets) {
      if (this.pendingBars[market] && this.pendingBars[market].length) {
        for (const bar of this.pendingBars[market]) {
          if (bar.time >= from && bar.time <= to) {
            results.push(bar)
          }
        }
      }
    }

    return results
  }

  formatColumns(columns) {
    return columns.reduce((acc, name, index) => {
      acc[name] = index
      return acc
    }, {})
  }
}

module.exports = InfluxStorage
