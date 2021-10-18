// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


/*  
    NOTE: *** this prog generates a lot of console messages!  And some debug files written to disk.

    This is the main backend analysis process.  Call this directly: node main.js <args>

        - establishes xrpl-client connection
        - listens for tx and ledger streams
        - performs "catchup" between last known ledger idx and now if no data or if ledger skip detected (eg. disconnects)
        - processes found trades into presentation JSON for sending over websocket to connected web front-end clients
        - forks child helper processes to do background data gathering when needed so this main process is not blocked from live ledger watching


    Prerequisites:
        - ws.cer: SSL certificate to run the secure websocket
        - ws.key: SSL private key for the websocket server
        - ws.ca: (optional, as needed) Certificate Authority file if needed
        - ./websocket/ws.js: PORT to use (free port on system)


*/


const fs = require('fs');
const path = require('path');

const { formatNumber } = require('./helpers/formatNumber.js')
const { getArgs } = require('./helpers/arguments.js')
const { setupFork } = require('./helpers/forker.js')

const { XrplClient } = require("xrpl-client");

const transactionParser  = require('ripple-lib-transactionparser');

const { initWebsocketServer, sendWebsocketData } = require('./websocket/ws.js')

const { rippleTimeToISO8601, rippleToUnixTimestamp } = require('./helpers/xrpl-helpers.js')


// hold the last set of published data for each page (for comparison if anything has changed)
let mostRecentTokenVolumePublic = null
let mostRecentTokenListPublic = null


const MS_24HOURS = 24*60*60*1000;   // milliseconds in 24 hours as constant


// global vars for monitoring state amongst the various events
let live_monitoring_enable = false
let catchup_success = false

let firstLedgerTxProcessedValid = null
let txBeingProcessed = false
let listOfOrdersByIOU = {}  // main holder of all gather trade data, by issuer.
let tempListOfOrdersByIOU = {} // cloned copy of above during some operations (eg. catchup)
let listOfObligationsByIssuer = {}   // holds obligation, latest price and kyc state too
let listOfRates = []
let issuersForHistoryGet = {}


// child (fork) var for getting 24-hr data when needed
let child24Getter = null
let forceHistoryGet = false

// child (fork) var for getting price/obligation/kyc data for a given array of pairs
let childPairGetter = null
let childPairGetterWaiting = false


// array to hold data of pairs that have been affected by order book entries and thus would need updates on their orderbook price
let batchPairsAffectingOrderBooks = []


// global to hold gathered price oracle data
let priceOracle = {
    has24hours: false,
    history: []
}
let priceOracleFeed = {}    // usurped by priceOracle somewhat, but kept for the moment in case of further fiat conversions in future



let issuerCurrencies = {}

let statsCalculated = {}    // holds intermediate stats after each ledger event for further refinement to each websocket endpoint
let statsDateTimes = {} 



// vars to hold details on which ledger is being processed in each substage
let last_ledger_index = 0;
let catchup_to_ledger_index = 0;
let current_ledger_index = 0;

// array to hold incoming tx stream data in a stack while we process other data (eg. catchup) which can then be processed afterwards from the stack
let liveTxStack = []


// vars to deal with ledger disconnects and retries
let need_ledger_index_after_reconnect = false
let ledger_index_after_reconnect = []
let ledger_index_last = 0
let skippedNeedsCatchup = []  // holds last known good ledger on skip detection




// QUIT PROC - when we exit this proc, save the "database" of certain vars to JSON file for reading in next time we launch
const SigTermExit = async() => {
    try {
        // save the listOfOrdersByIOU to file for reloading when restarted
        if (current_ledger_index > catchup_to_ledger_index && Object.keys(listOfOrdersByIOU).length > 0) {
            console.log('>>>>> writing to file last_ledger_index of ', last_ledger_index)
            fs.writeFileSync('./listOfOrdersByIOU.json', JSON.stringify({
                firstLedgerTxProcessedValid,
                last_ledger_index,
                listOfObligationsByIssuer,
                listOfRates,
                listOfOrdersByIOU,
                issuersForHistoryGet,
                priceOracle,
            }, null, 2))
            //
        } else {
            console.log('>>>>> NOT WRITING TO FILE AS CURRENT LEDGER is <= CATCHUP_TO LEDGER, or list is zero:', current_ledger_index, catchup_to_ledger_index, Object.keys(listOfOrdersByIOU).length)
        }
        console.log('Safe exit now.')
    } catch(err) {
        console.log('ERROR: cannot SigTermExit properly', err)
    } finally {
        process.exit(0);
    }
}


process
    .once('SIGTERM', SigTermExit)
    .once('SIGINT',  SigTermExit);
    



Array.prototype.unique = function() {
    return this.filter(function(value, index, array) {
        return array.indexOf(value, index + 1) < 0;
    });
};

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}  


function clone(obj) {
    if (obj === null || typeof (obj) !== 'object' || 'isActiveClone' in obj)
        return obj;

    let temp
    if (obj instanceof Date)
        temp = new obj.constructor(); 
    else
        temp = obj.constructor();

    for (let key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            obj['isActiveClone'] = null;
            temp[key] = clone(obj[key]);
            delete obj['isActiveClone'];
        }
    }
    return temp;
}


function hex_to_ascii(str1) {
    var hex  = str1.toString();
    var str = '';
    for (var n = 0; n < hex.length; n += 2) {
        if (hex.substr(n, 2) != '00') {
		    str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
        }
    }
    return str;
}


const currencyToAscii = (ccy) => {
    return ccy.length == 40 ? hex_to_ascii(ccy) : ccy
}


function isObject(object) {
    return object != null && typeof object === 'object';
}

function deepEqual(object1, object2) {
    const keys1 = Object.keys(object1);
    const keys2 = Object.keys(object2);
    if (keys1.length !== keys2.length) {
        return false;
    }
    for (const key of keys1) {
        const val1 = object1[key];
        const val2 = object2[key];
        const areObjects = isObject(val1) && isObject(val2);
        if (
            (areObjects && !deepEqual(val1, val2)) ||
            (!areObjects && val1 !== val2)
        ) {
            return false;
        }
    }
    return true;
}






// this proc calculates stats from the trade data as an intermediary, to then be used by other procs to fine-tune the data sent to clients
const calculateRunningTotals = async() => {

    const toDate = new Date().toISOString()
    const fromDate = new Date(((Date.now() / 1000) - (24*60*60)) * 1000).toISOString()


    statsDateTimes.toDate = toDate
    statsDateTimes.fromDate = fromDate

    statsCalculated = {}  // zero it!

    // first, keep trades that are approx 24 hours old or newer - we can discard older trades because at this stage we are not reporting stats beyond 24 hours
    Object.values(listOfOrdersByIOU).filter(iou => iou.trades && iou.trades.length > 0).forEach(iou => {
        iou.trades = iou.trades.filter(t => t.ts >= fromDate && t.ts <= toDate)
    })

    // now process them to form summary stats
    Object.values(listOfOrdersByIOU).filter(iou => iou.trades && iou.trades.length > 0).forEach(iou => {

        // filter into date range we're interested in (could remove now we have a check above for this but keep incase we change reporting periods later)
        iou.trades.filter(t => t.ts >= fromDate && t.ts <= toDate).forEach(trade => {

            // before we create the summary entry for this pair as set, ensure we don't already have this pair summarised but inverted eg:
            // rKi...CNY / CNY...raz
            // If we do have this pair but inverted already, invert this pair for processing and add to the existing totals
            const invertedPairing = trade.op['cp'] && statsCalculated[trade.op.cp] && statsCalculated[trade.op.cp][trade.op.ccy] && statsCalculated[trade.op.cp][trade.op.ccy].find(c => c.counter.currency == trade.ccy && c.counter.issuer == trade.iss)
            if (invertedPairing !== undefined) {
                // we need to use the inverted pairing for summary
                counterEl = invertedPairing
                counterEl.sums.base += trade.op.am;
                counterEl.sums.quote += trade.am;
                counterEl.sums.fxusd += trade['fxusd'] || 0
                counterEl.sums.trade_count += 1

                counterEl.obligations = {
                    base: listOfObligationsByIssuer[trade.op.cp] && listOfObligationsByIssuer[trade.op.cp].ccy[trade.op.ccy],
                    quote: listOfObligationsByIssuer[trade.iss] && listOfObligationsByIssuer[trade.iss].ccy[trade.ccy],
                    mcap: listOfObligationsByIssuer[trade.op.cp] && listOfObligationsByIssuer[trade.op.cp].mcap && listOfObligationsByIssuer[trade.op.cp].mcap[trade.op.ccy],
                    pricefx: listOfObligationsByIssuer[trade.op.cp] && listOfObligationsByIssuer[trade.op.cp].pricefx && listOfObligationsByIssuer[trade.op.cp].pricefx[trade.op.ccy],
                }

                if (trade.ts > counterEl.last_ts) {
                    counterEl.last_ts = trade.ts
                    counterEl.last_dir = trade.dir
                    counterEl.last_rate = 1 / trade.rate
                }

                // set the rates
                const rates = listOfRates.find(r => r.base.issuer == trade.op['cp'] && r.base.ccy == trade.op.ccy  && r.quote.issuer == trade.iss && r.quote.ccy == trade.ccy)
                // console.log('rates for ', iou.currency, trade.op.ccy, rates)
                if (rates != undefined && rates.prices != undefined) {
                    counterEl.ask = rates.prices['ask'] //&& rates.prices.ask.toFixed(15)
                    counterEl.bid = rates.prices['bid'] //&& rates.prices.bid.toFixed(15)
                    counterEl.mid = rates.prices['mid'] //&& rates.prices.mid.toFixed(15)
                    counterEl.spr = rates.prices['spr'] //&& rates.prices.spr.toFixed(15)
                }
                
            } else {

                // we don't have the inverted pairing present, so create it on this one
                if (!statsCalculated[iou.issuer]) {
                    statsCalculated[iou.issuer] = {}
                }
                if (!statsCalculated[iou.issuer][iou.currency]) {
                    statsCalculated[iou.issuer][iou.currency] = []
                }
            

                let counterEl = statsCalculated[iou.issuer][iou.currency].find(c => c.counter.currency == trade.op.ccy && c.counter.issuer == trade.op.cp)
                if (counterEl == undefined) {

                    counterEl = {
                        counter: {
                            currency: trade.op.ccy,
                            issuer: trade.op.cp,
                        },
                        sums: {
                            base: 0,
                            quote: 0,
                            fxusd: 0,
                            trade_count: 0,
                        },
                        last_ts: '',
                        last_dir: null
                    }
                    statsCalculated[iou.issuer][iou.currency].push(counterEl)
                }


                counterEl.sums.base += trade.am;
                counterEl.sums.quote += trade.op.am;
                counterEl.sums.fxusd += trade['fxusd'] || 0
                counterEl.sums.trade_count += 1

                counterEl.obligations = {
                    base: listOfObligationsByIssuer[iou.issuer] && listOfObligationsByIssuer[iou.issuer].ccy[iou.currency],
                    quote: listOfObligationsByIssuer[trade.op.cp] && listOfObligationsByIssuer[trade.op.cp].ccy[trade.op.ccy],
                    mcap: listOfObligationsByIssuer[iou.issuer] && listOfObligationsByIssuer[iou.issuer].mcap && listOfObligationsByIssuer[iou.issuer].mcap[iou.currency],
                    pricefx: listOfObligationsByIssuer[iou.issuer] && listOfObligationsByIssuer[iou.issuer].pricefx && listOfObligationsByIssuer[iou.issuer].pricefx[iou.currency],
                }

                if (trade.ts > counterEl.last_ts) {
                    counterEl.last_ts = trade.ts
                    counterEl.last_dir = trade.dir
                    counterEl.last_rate = trade.rate
                }

                // set the rates
                const rates = listOfRates.find(r => r.base.issuer == iou.issuer && r.base.ccy == iou.currency && (trade.op['cp'] ? r.quote.issuer == trade.op.cp : true) && trade.op.ccy == r.quote.ccy)

                if (rates != undefined && rates.prices != undefined) {
                    counterEl.ask = rates.prices['ask'] //&& rates.prices.ask.toFixed(15)
                    counterEl.bid = rates.prices['bid'] //&& rates.prices.bid.toFixed(15)
                    counterEl.mid = rates.prices['mid'] //&& rates.prices.mid.toFixed(15)
                    counterEl.spr = rates.prices['spr'] //&& rates.prices.spr.toFixed(15)
                }
            }
        })
    })

    // DEBUG
    // fs.writeFileSync('./statsCalculated.json', JSON.stringify(statsCalculated, null, 2))
}





// proc to create json data to send for the list of token pairs trading activity
const getFrontpageTokenVolume = async() => {
    let data = Object.entries(statsCalculated).reduce((acc, [issuer, statroot]) => {

        Object.entries(statroot).forEach(([currency, currencyBlock]) => {
            currencyBlock.forEach(currencyStats => {
                acc.push(
                    {
                        base:               issuer + '.' + currencyToAscii(currency),
                        base_ccy:           currencyToAscii(currency),
                        base_issuer:        issuer,
                        base_kyc:           listOfObligationsByIssuer[issuer] && listOfObligationsByIssuer[issuer]['kyc'],
                        quote:              (currencyStats.counter.issuer ? currencyStats.counter.issuer + '.' : '') + currencyToAscii(currencyStats.counter.currency),
                        quote_issuer:       (currencyStats.counter.issuer ? currencyStats.counter.issuer : undefined),
                        quote_kyc:          currencyStats.counter.issuer && listOfObligationsByIssuer[currencyStats.counter.issuer] ? listOfObligationsByIssuer[currencyStats.counter.issuer]['kyc'] : undefined,
                        quote_ccy:          currencyToAscii(currencyStats.counter.currency),
                        
                        traded_vol_base:    currencyStats.sums.base ? (currencyStats.sums.base < 100 ? +formatNumber(currencyStats.sums.base < 10 ? 6 : 4, currencyStats.sums.base) : +currencyStats.sums.base.toFixed(0)) : null,
                        traded_vol_quote:   currencyStats.sums.quote ? (currencyStats.sums.quote < 100 ? +formatNumber(currencyStats.sums.quote < 10 ? 6 : 4, currencyStats.sums.quote) : +currencyStats.sums.quote.toFixed(0)) : null,

                        has24hr:            firstLedgerTxProcessedValid.morethan24hours ? true : issuersForHistoryGet[issuer]?.has24hr === true || listOfOrdersByIOU[issuer + '.' + currency]['has24hr'],

                        
                        traded_last_time:   currencyStats.last_ts,
                        traded_last_dir:    currencyStats.last_dir,
                        traded_last_rate:   currencyStats.last_rate,

                        quote_fxusd:        currencyStats.sums.fxusd,

                        base_obligation:    currencyStats.obligations.base,
                        quote_obligation:   currencyStats.obligations.quote,

                        mcap:               currencyStats.obligations.mcap,
                        pricefx:            currencyStats.obligations.pricefx,  //USD price based on XRP pairing price
     
                        mid:                (currencyStats['mid'] || 0).toFixed(10),        
                        spr:                (currencyStats['spr'] || 0).toFixed(10),        

                    }
                )
            })
        })
        
        return acc
    }, []) 

    // sort by base_cur, then base_issuer
    data = data.sort((a, b) => {
        let comparison = 0
        if (a.base_ccy > b.base_ccy) {
            comparison = 1
        }
        else if (a.base_ccy < b.base_ccy) {
            comparison = -1
        }

        // If still 0 then sort by second criteria descending
        if (comparison === 0) {
            if (a.base_issuer > b.base_issuer) {
                comparison = 1
            }
            else if (a.base_issuer < b.base_issuer) {
                comparison = -1
            }
        }
        return comparison
    })


    // sum all pairs USD volume
    const sumUsd = data.reduce((acc, val) => acc + val.quote_fxusd, 0)


    // sum all token base+quote amounts together
    return {
        period: statsDateTimes,
        token_volume: data,
        sum_usd: sumUsd
    }
}




// proc to do the sending of the token volume json via websockets to connected clients, if data has changed
const wsPublishTokenVolume = async(sendAlways = false) => {
    const hl = await getFrontpageTokenVolume()
    if (hl !== false) {
        if (sendAlways || (mostRecentTokenVolumePublic == null || !deepEqual(hl, mostRecentTokenVolumePublic))) {
            mostRecentTokenVolumePublic = hl
            await sendWebsocketData('/token-volume', hl);
        } else {
            console.log('>>>>> SKIPPING SENDING (TOKEN PAIRS) DATA AS NOTHING HAS CHANGED')
        }
    }
}




// proc to gather json to send for the list of tokens recently traded for front-end frontpage of website
const getFrontpageTokenList = async() => {
    let data = Object.entries(statsCalculated).reduce((acc, [issuer, statroot]) => {

        Object.entries(statroot).forEach(([currency, currencyBlock]) => {

            acc.push({
                issuer: issuer,
                kyc: listOfObligationsByIssuer[issuer] && listOfObligationsByIssuer[issuer]['kyc'],
                ccy: currencyToAscii(currency),
                sum_traded_24hr: currencyBlock.reduce((sumusd, el) => sumusd + el.sums.base, 0),
                fxusd_traded_24hr: currencyBlock.reduce((sumusd, el) => sumusd + el.sums.fxusd, 0),
                obligation: currencyBlock[0]?.obligations.base,
                mcap: currencyBlock[0]?.obligations.mcap,
                price_mid: currencyBlock[0]?.obligations.pricefx,  //currencyBlock.reduce((summid, el) => summid + el.mid, 0) / currencyBlock.length,
                last_traded: currencyBlock.reduce((lastts, el) => el.last_ts > lastts ? el.last_ts : lastts, ''),
                trade_count: currencyBlock.reduce((counttotal, el) => counttotal + el.sums.trade_count , 0),
            })

        })
        
        return acc
    }, [])

    
    // sort by ccy, then issuer
    data = data.sort((a, b) => {
        let comparison = 0
        if (a.ccy > b.ccy) {
            comparison = 1
        }
        else if (a.ccy < b.ccy) {
            comparison = -1
        }

        // If still 0 then sort by second criteria descending
        if (comparison === 0) {
            if (a.issuer > b.issuer) {
                comparison = 1
            }
            else if (a.issuer < b.issuer) {
                comparison = -1
            }
        }
        return comparison
    })


    

    // sum all token base+quote amounts together
    return {
        period: statsDateTimes,
        token_list: data,
        sum_usd: data.reduce((acc, val) => acc + val.fxusd_traded_24hr, 0),
        trade_count: data.reduce((acc, val) => acc + val.trade_count, 0),
        period_size_mins: firstLedgerTxProcessedValid ? Math.min(24*60, (Date.now() - firstLedgerTxProcessedValid.close_time_unix) / (1000*60)) : 1,
    }
}




// proc to do the sending of the token list if changed to connected WS clients
const wsPublishTokenList = async(sendAlways = false) => {
    const hl = await getFrontpageTokenList()
    if (hl !== false) {
        if (sendAlways || (mostRecentTokenListPublic == null || !deepEqual(hl, mostRecentTokenListPublic))) {
            mostRecentTokenListPublic = hl
            await sendWebsocketData('/token-list', hl);
        } else {
            console.log('>>>>> SKIPPING SENDING (TOKEN LIST) DATA AS NOTHING HAS CHANGED')
        }
    }
}





// this proc is called in main() to start the catchup process when required (first start after a period of not running, or on ledger skip detection)
const initializeCatchup = async(client, catchupFromIndexInc, catchupToIndexInc, needsLiveTxTrackingEnable = false) => {

    // was 66967520, now 66967525
    // => catchupFromIndexInc = 66967520, catchupToIndexInc = 66967524
    // in this example, we need to clear all trades from the "was" 66967520 up to but excluding the "now" 66967525 (just in case we get duplicates from live tracking)

    live_monitoring_enable = false

    last_ledger_index = catchupFromIndexInc
    catchup_to_ledger_index = catchupToIndexInc

    console.log('CATCHUP REQUIRES', catchup_to_ledger_index - last_ledger_index, ' LEDGERS TO GO....')

    // now start the subscription to the live transactions to place onto the stack after catchup_to_ledger_index
    if (needsLiveTxTrackingEnable) enableLiveTxTracking({client})

    // clone the listOfTrades to a temp array for catchup purposes
    tempListOfOrdersByIOU = clone(listOfOrdersByIOU)

    // remove the "was" upto "now-1"
    Object.values(tempListOfOrdersByIOU).forEach(iou => {
        iou.trades = iou.trades.filter(t => t.lv < last_ledger_index || t.lv > catchup_to_ledger_index)
    })
    // now go querying each ledger
    catchup_success = await catchUpToLedger({client, from: last_ledger_index, to: catchup_to_ledger_index})

    if (catchup_success) {
        // copy temp back to live list
        listOfOrdersByIOU = clone(tempListOfOrdersByIOU)
        console.log('****** CATCHUP SUCCESSFUL')
        live_monitoring_enable = true
    } else {
        console.log('****** CATCHUP FAILED, NOT MONITORING TXS.')
    }

    return true
}




// proc to gather trading data from a given ledger, en-masse, from a starting ledger to and ending ledger.
// Used on detected ledger skip (disconnection / reconnection) or when triggered by commandline argument to force a catchup
const catchUpToLedger = async(params) => {

    // loop through each ledger one by one, processing txs as they are found
    let get_ledger_index = params.from;
    let target_ledger_index = params.to;
    let data
    let force_quit = false

    while (get_ledger_index <= target_ledger_index && force_quit != true) {
        try {
            console.log('GETTING CATCHUP LEDGER', get_ledger_index, '.... live current ledger is', current_ledger_index, '(', current_ledger_index-get_ledger_index, 'away)')
            data = await params.client.send({
                command: 'ledger',
                ledger_index: get_ledger_index,
                full: false,
                accounts: false,
                transactions: true,
                expand: true,
                owner_funds: false,
            });

            if (!data['ledger']) {
                console.error('???? ERROR no ledger property:', data)
            }

            // process this block of transactions
            data.ledger.transactions.forEach(tx => {
                // console.dir(tx, {depth: null})
                // format of data is slightly different to tx watcher, so shape the data the way it's expected first...
                tx.engine_result = tx.metaData.TransactionResult
                tx.transaction = {...tx, date: data.ledger.close_time}
                tx.meta = tx.metaData
                tx.ledger_index = data.ledger.ledger_index
                tx._isCatchup = true
                // now process it
                processIncomingTransaction(params.client, tx, tempListOfOrdersByIOU)
            })

            // sleep every now and again
            if (get_ledger_index % 10 == 0) {
                console.log('SLEEPING....')
                await sleep(500);
            }

            // ensure last_ledger_index is updated after processing these txs (so any exit after catchup saves data to file with correct last ledger number)
            last_ledger_index = get_ledger_index

            // move on to next one
            get_ledger_index += 1;


            console.log('CATCHUP ', target_ledger_index - get_ledger_index, ' LEDGERS TO GET...')



        } catch(err) {
            console.error('************** ERROR in catchup', err)
            force_quit = true
        }
    }

    return !force_quit   // return true if successful
}






// proc to actually process an incoming tx (order trade) to analyse it and save it to appropriate variable pointer
const processIncomingTransaction = (client, tx, ptrSaveTo) => {
    
    if (tx.engine_result != 'tesSUCCESS') {
        return
    }
        
    // PRICE ORACLE FEED TRANSACTION
    if (tx.transaction.Account == 'rXUMMaPpZqPutoRszR29jtC8amWq3APkx') {
        // XUMM price oracle account, get XRPUSD price
        priceOracleFeed['XRP/USD'] = +tx.transaction.LimitAmount.value
        priceOracle.history.push({
            ledger_index: tx.ledger_index,
            usd_rate: +tx.transaction.LimitAmount.value
        })
        console.log('PRICE ORACLE UPDATE: ', priceOracleFeed)
        // console.log(tx.transaction.TransactionType)
        // console.dir(tx, {depth: null})
        return
    }

    
    // only interested in OfferCreate that are filled or Payments 
    if (!['OfferCreate', 'Payment'].includes(tx.transaction.TransactionType)) {
        return
    }
    
    let issPairsTraded = []

    const orderbookChanges = transactionParser.parseOrderbookChanges(tx.meta)
    // make sure there is a status='filled' or status='partially-filled' for this tx, otherwise ignore
    const hasFilledOrders = Object.values(orderbookChanges).some(obc => obc.some(event => event.status == 'filled' || event.status == 'partially-filled'))
    if (hasFilledOrders) {
        // console.log('**********************************************')
        // console.log('TX hash: ', tx.transaction.hash)
        // console.dir(orderbookChanges, {depth: null})
        // console.log('Tx.Transaction.Account: ', tx.transaction.Account)
        // console.dir(tx, {depth: null})
    
        Object.entries(orderbookChanges).forEach(entry => {
            // console.log('entry is ', entry)
            const [key, kvalue] = entry;
            kvalue.forEach(value => {
                if (['filled', 'partially-filled'].includes(value.status)) {
                    // console.log('order filled is ', value)
                    // is it sell or buy?
                    let event = {}
                    try {
                        event.ts = rippleTimeToISO8601(tx.transaction.date)   //tx.outcome.timestamp
                    }catch(err) {
                        console.log('ERROR time:')
                        console.dir(tx, {depth: null})
                        // console.dir(value)
                    }

                    if (value.quantity['counterparty']) {
                        event.DEBUG = 'quantity_counterparty'
                        event.ccy = value.quantity.currency
                        event.iss = value.quantity.counterparty
                        event.am = +value.quantity.value
                        event.tx = tx.transaction.hash
                        event.lv = tx.ledger_index
                        event.iil = tx.meta.TransactionIndex
                        // event.fa = ((value.direction == 'sell') && (value.quantity['currency'] == theBase.currency)) || ((value.direction == 'buy') && (value.quantity['currency'] != theBase.currency))  ? key : tx.address
                        // event.ta = ((value.direction == 'sell') && (value.quantity['currency'] == theBase.currency)) || ((value.direction == 'buy') && (value.quantity['currency'] != theBase.currency)) ? tx.address : key
                        
                        event.dir = ((value.direction == 'sell') && (value.quantity['currency'] == event.ccy && value.quantity['counterparty'] == event.iss)) ||
                                    ((value.direction == 'buy') && (value.quantity['currency'] != event.ccy && value.quantity['counterparty'] != event.iss))
                                    ? 'buy' : 'sell'


                        event.op = {
                            am: +value.totalPrice.value,
                            ccy: value.totalPrice.currency
                        }
                        if (value.totalPrice.counterparty) {
                            event.op.cp = value.totalPrice.counterparty
                        }

                        event.rate = (event.op.am / event.am)

                        if (!ptrSaveTo[event.iss + '.' + event.ccy]) {
                            ptrSaveTo[event.iss + '.' + event.ccy] = {
                                currency: event.ccy,
                                issuer: event.iss,
                                trades: []
                            }
                        }
                        ptrSaveTo[event.iss + '.' + event.ccy].trades.push(event)
                        // console.table(event)
                        console.log(`processed ${tx['_isCatchup'] ? 'CATCHUP ' : ''}event in ledger`,  tx.ledger_index, `for ${event.ccy}.${event.iss}`)


                        

                    } else
                    
                    if (value.totalPrice['counterparty']) {
                        event.DEBUG = 'totalPrice_counterparty'
                        event.ccy = value.totalPrice.currency
                        event.iss = value.totalPrice.counterparty
                        event.am = +value.totalPrice.value
                        event.tx = tx.transaction.hash
                        event.lv = tx.ledger_index
                        event.iil = tx.meta.TransactionIndex

                        event.dir = ((value.direction == 'sell') && (value.quantity['currency'] == event.ccy && value.quantity['counterparty'] == event.iss)) ||
                                    ((value.direction == 'buy') && (value.quantity['currency'] != event.ccy && value.quantity['counterparty'] != event.iss))
                                    ? 'buy' : 'sell'

                        event.op = {
                            am: +value.quantity.value,
                            ccy: value.quantity.currency,
                        }
                        if (value.quantity.counterparty) {
                            event.op.cp = value.quantity.counterparty
                        }
                        event.rate = (event.op.am / event.am)

                        if (!ptrSaveTo[event.iss + '.' + event.ccy]) {
                            ptrSaveTo[event.iss + '.' + event.ccy] = {
                                currency: event.ccy,
                                issuer: event.iss,
                                trades: []
                            }
                        }
                        ptrSaveTo[event.iss + '.' + event.ccy].trades.push(event)
                        // console.table(event)
                        console.log(`processed ${tx['_isCatchup'] ? 'CATCHUP ' : ''}event in ledger`,  tx.ledger_index, `for ${event.ccy}.${event.iss}`)

                        

                    }

                    // calculate any BASE/XRP price as USD equiv using price oracle
                    if (event.op.ccy == 'XRP') {
                        event.fxusd = priceOracleFeed['XRP/USD']  * event.op.am;
                    } else
                    if (event.op.ccy == 'USD') {
                        event.fxusd = event.op.am
                    } else
                    if (event.ccy == 'USD') {
                        event.fxusd = event.am
                    } else {
                        // look up base against XRP in the recent trades list, see if we have an average rate over the last X minutes, use that to get an implied rate for this pair going forwards

                        console.log(`**** ${event.iss + '.' + event.ccy} VS ${event.op.cp + '.' + event.op.ccy}`)

                        let useRatesFrom = null
                        let usedSide = null
                        if (ptrSaveTo[event.iss + '.' + event.ccy] && ptrSaveTo[event.iss + '.' + event.ccy]['trades'] && ptrSaveTo[event.iss + '.' + event.ccy]['trades'].length > 0) {
                            useRatesFrom = ptrSaveTo[event.iss + '.' + event.ccy].trades.filter(t => t.op.ccy == 'XRP')
                            usedSide = 'base'
                            console.log('using base')
                        } else
                        if (ptrSaveTo[event.op.cp + '.' + event.op.ccy] && ptrSaveTo[event.op.cp + '.' + event.op.ccy]['trades'] && ptrSaveTo[event.op.cp + '.' + event.op.ccy]['trades'].length > 0) {
                            useRatesFrom = ptrSaveTo[event.op.cp + '.' + event.op.ccy].trades.filter(t => t.op.ccy == 'XRP')
                            usedSide = 'quote'
                            console.log('using quote')
                        } else {
                            console.log('CANT USE ANYTHING')
                        }

                        if (useRatesFrom != null) {
                            // make temp array of just ts and rate, and sort DESC by ts
                            const ratesToUse = useRatesFrom.map(t => ({ts: t.ts, rate: t.rate})).sort((a, b) => {
                                if (a.ts < b.ts) {
                                    return 1;
                                }
                                if (a.ts > b.ts) {
                                    return -1;
                                }
                                return 0;
                            })
                            // now filter by last few trades for avg rate (crude but will do for approximation of rate)
                            .slice(0, 4)
                            console.log('RATES TO USE IS', ratesToUse, ratesToUse.length)
                            // now find the avg of the rates
                            const sumRates = ratesToUse.reduce((cum, val) => cum + val.rate, 0)
                            console.log('SUMRATES: ', sumRates)
                            const avgRate = sumRates / ratesToUse.length
                            console.log('AVERAGE RATE IS', avgRate)
                            // apply this rate in the correct direction depending on if it is base or quote we are having to use
                            if (usedSide == 'base') {
                                event.fxusd = event.am * avgRate * priceOracleFeed['XRP/USD']
                            } else {
                                event.fxusd = (event.op.am * avgRate) * priceOracleFeed['XRP/USD']
                            }
                            console.log('FXUSD equiv is ', event.fxusd, event)
                        }
                    }


                    // record the fact that we have processed a certain issuer and currency -  so we can perform an obligation check next if necessary
                    if (issuerCurrencies[event.iss] == undefined) issuerCurrencies[event.iss] = {}
                    issuerCurrencies[event.iss][event.ccy] = true

                    if (event.op.cp) {
                        if (issuerCurrencies[event.op.cp] == undefined) issuerCurrencies[event.op.cp] = {}
                        issuerCurrencies[event.op.cp][event.op.ccy] = true
                    }



                    // record the fact that we have processed a certain issuer - so we can perform a 24hr history check if necessary
                    if (issuersForHistoryGet[event.iss] == undefined) issuersForHistoryGet[event.iss] = {
                        needed: true,
                        requested: false,
                        ledger_upto: tx.ledger_index - 1
                    }
                    if (event.op.cp) {
                        if (issuersForHistoryGet[event.op.cp] == undefined) issuersForHistoryGet[event.op.cp] = {
                            needed: true,
                            requested: false,
                            ledger_upto: tx.ledger_index - 1
                        }
                    }


                    // record the order book pattern we want to be getting every so often
                    if (listOfRates.find(r => r.base.issuer == event.iss && r.base.ccy == event.ccy && (event.op['cp'] ? r.quote.issuer == event.op.cp : true) && event.op.ccy == r.quote.ccy) == undefined) {
                        // add it
                        listOfRates.push({
                            lastCheckedLedger: 0,
                            base: {
                                issuer: event.iss,
                                ccy: event.ccy,
                            },
                            quote: {
                                issuer: event.op['cp'],
                                ccy: event.op.ccy,
                            }
                        })
                    }



                    // record the fact that this iss and ccy was used somewhere in this processing
                    if (issPairsTraded.find(o => o.issuer == event.iss && o.ccy == event.ccy && o.op['issuer'] == event.op['cp'] && o.op.ccy == event.op.ccy) == undefined) {
                        issPairsTraded.push({
                            issuer: event.iss,
                            ccy: event.ccy,
                            op: {
                                issuer: event.op['cp'],
                                ccy: event.op.ccy
                            }
                        })
                    }
                    


                }
            })
        })

        // console.log('listOfOrdersByIOU is:');
        // console.dir(listOfOrdersByIOU, {depth: null});
        console.log('**********************************************')

    }

    // save last processed ledger_index so when we restart we can start from this one onwards (less 1 ledger incase we force exited mid-way through a ledger's processing)
    last_ledger_index = tx.ledger_index


    return issPairsTraded

    


    
}



// proc to enable live tracking when we are ready to do so
const enableLiveTxTracking = (params) => {
    params.client.send({
        command: 'subscribe',
        streams: ['transactions'],
        accounts: [
            "rXUMMaPpZqPutoRszR29jtC8amWq3APkx"
        ]
    })
}





// this proc looks at the next entry in the live tx stack, sends it for processing, checks if price/obligation check is required to be forked, etc.
const processTxStack = async(client) => {
    // don't process the stack if one is already being processed...
    if (txBeingProcessed) {
        return
    }

    // mark the whole procedure as being "busy" so we don't execute this process while we are processing one already
    txBeingProcessed = true

   
    // we are not processing anything, so let's process the stack now....
    // while we have some in the stack...
    while (liveTxStack.length > 0) {
        // shift one off the top...
        const tx = liveTxStack.shift()


        // is this the first ever ledger tx we have processed?  If so, record it as we will need some of these details to determine the 24hr catchup/lookback later
        if (firstLedgerTxProcessedValid == null) {

            firstLedgerTxProcessedValid = {
                ledger_index: tx.ledger_index,
                ts: rippleTimeToISO8601(tx.transaction.date),
                close_time_unix: rippleToUnixTimestamp(tx.transaction.date),
                morethan24hours: false,
            }
 
        } else

        if (!firstLedgerTxProcessedValid.morethan24hours) {
            // if its been running for more than 24 hours, there is no need to bulk get trade history as we've been live-monitoring for the minimum 24 hours needed
            if (rippleToUnixTimestamp(tx.transaction.date) - firstLedgerTxProcessedValid.close_time_unix > MS_24HOURS) {
                firstLedgerTxProcessedValid.morethan24hours = true
            }
        }




        
        // process it... (sets txBeingProcessed to true at the start and to false on finally)
        const issPairsTraded = processIncomingTransaction(client, tx, listOfOrdersByIOU)

        // for each pair analysed successfully, we need to check pricing data for it (and obligation/kyc too), so record that pairing for later
        issPairsTraded && issPairsTraded.forEach(a => {
            if (batchPairsAffectingOrderBooks.find(bp => bp.issuer == a.issuer && bp.ccy == a.ccy && bp.op['issuer'] == a.op['issuer'] && bp.op.ccy == a.op.ccy) == undefined) {
                // add it
                batchPairsAffectingOrderBooks.push(a)
            }
        })

        // now check if any offercancels affect pairs we are interested in, so we know which ones to get latest OB pricing data for
        if (['OfferCancel'].includes(tx.transaction.TransactionType)) {
            // console.log('OfferCancel for', tx.transaction.hash)
            const pobc = transactionParser.parseOrderbookChanges(tx.meta)
            // console.dir(pobc, {depth: null})
            Object.entries(pobc).forEach(entry => {
                const [key, kvalue] = entry;
                kvalue.forEach(value => {
                    if (value.quantity['counterparty']) {

                        // is it a pair we are actually tracking?  Or is it a pair that is having lots of offercancel activity but that is not actually trading?
                        if (listOfOrdersByIOU[value.quantity['counterparty'] + '.' + value.quantity['currency']] !== undefined) {

                            if (batchPairsAffectingOrderBooks.find(bp => bp.issuer == value.quantity['counterparty'] && bp.ccy == value.quantity['currency'] && bp.op['issuer'] == value.totalPrice['counterparty'] && bp.op.ccy == value.totalPrice['currency']) == undefined) {
                                // add it
                                batchPairsAffectingOrderBooks.push({
                                    issuer: value.quantity['counterparty'],
                                    ccy: value.quantity['currency'],
                                    op: {
                                        issuer: value.totalPrice['counterparty'],
                                        ccy: value.totalPrice['currency']
                                    }
                                })
                            }
                        
                        }
                    } else
                    if (value.totalPrice['counterparty']) {
                        // is it a pair we are actually tracking?  Or is it a pair that is having lots of offercancel activity but that is not actually trading?
                        if (listOfOrdersByIOU[value.totalPrice['counterparty'] + '.' + value.totalPrice['currency']] !== undefined) {

                            if (batchPairsAffectingOrderBooks.find(bp => bp.issuer == value.totalPrice['counterparty'] && bp.ccy == value.totalPrice['currency'] && bp.op['issuer'] == value.quantity['counterparty'] && bp.op.ccy == value.quantity['currency']) == undefined) {
                                // add it
                                batchPairsAffectingOrderBooks.push({
                                    issuer: value.totalPrice['counterparty'],
                                    ccy: value.totalPrice['currency'],
                                    op: {
                                        issuer: value.quantity['counterparty'],
                                        ccy: value.quantity['currency']
                                    }
                                })
                            }
                        }
                    }
                })
            })
        }
        

        // is it <24hours since the starting ledger on zero-data gathering instantiation?  If so, allow the 24 hour getter, otherwise we've been running more than 24 hours so everything we need has been caught "live"
        // look through issuersForHistoryGet and find any .needed = true but .requested = false
        if ((!firstLedgerTxProcessedValid.morethan24hours || forceHistoryGet !== false) && (child24Getter == null)) {
            
            // have we got 24 hours of price oracle data yet?  If not, get it
            if (priceOracle.has24hours === false) {
                console.dir(firstLedgerTxProcessedValid)
                // get PO history first, before we gather anything else
                child24Getter = setupFork({
                    program: path.resolve('tx-24-priceoracle.js'),
                    parameters: ['--issuer=rXUMMaPpZqPutoRszR29jtC8amWq3APkx', '--ledger-max=' + (firstLedgerTxProcessedValid.ledger_index - 1)],
                    onMessageFn: childMessage24Getter,
                    onExitFn: childExit24Getter,
                })

            } else {

                // we have PO history data, so get block data for this issuer now

                if (forceHistoryGet) {
                    issuersForHistoryGet = {}
                    issuersForHistoryGet[forceHistoryGet] = {
                        needed: true,
                        requested: false,
                        ledger_upto: firstLedgerTxProcessedValid.ledger_index - 1
                    }
                    forceHistoryGet = false
                }

                let historyNeeded = (Object.entries(issuersForHistoryGet).filter(([issuer, obj]) => obj.needed == true /*&& obj.requested == false*/) || [])[0]
                if (historyNeeded != undefined) {
                    //historyNeeded[1].requested = true
                    console.log('>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> requesting 24 data for ', historyNeeded[0])
                    child24Getter = setupFork({
                        program: path.resolve('tx-24-getter.js'),
                        parameters: ['--issuer=' + historyNeeded[0], '--ledger-max=' + historyNeeded[1].ledger_upto],
                        onMessageFn: childMessage24Getter,
                        onExitFn: childExit24Getter,
                    })
                }
            }

        }

        // now return to the loop if we still have items in the stack ^^^
    }

    // flag that we have finished processing the stack of items, ready for next call
    txBeingProcessed = false

}







// process incoming data from the child fork to populate issuer(s) and currenc(y/ies) with 24-hour tx data
const childMessage24Getter = (msg) => {
    console.log('Message from 24getter: ', msg)

    if (msg.price_oracle) {
        // save price oracle data to history
        priceOracle.history.push(...msg.price_oracle)
        priceOracle.history.sort((a, b) => a.ledger_index - b.ledger_index)
        priceOracle.has24hours = true

    } else

    if (msg.block_trades) {

        issuersForHistoryGet[msg.block_trades.issuer].needed = false

        console.log('parent received getter data')
        // fs.writeFileSync('./getter_recvd_by_Parent_'+msg.block_trades.issuer + '_' + Date.now() +'.json', JSON.stringify(msg.block_trades, null, 2))


        // only add the <ccy>/XRP trades, and add the issuer of the other sides (<ccy>/<other>) to the need history list if necessary.  This saves on duplicates being entered.


        // copy to master list depending on if each iss.CCY entry exists in the master list yet or not
        // for each block_trades.trades key (iss.CCY), merge the .trades

        // get a list of all the transaction IDs gathered so far across everything
        const globalTxList =  Object.values(listOfOrdersByIOU).reduce((acc, val) => {
            acc.push(...val.trades.map(t => t.tx))
            return acc
        }, []).unique()
        // fs.writeFileSync('./UNIQUE_TX_LIST.json', JSON.stringify(globalTxList, null, 2))



        Object.entries(msg.block_trades.trades).forEach(([issCCY, obj]) => {
            if (listOfOrdersByIOU[issCCY] != undefined) {
                // add them on
                // console.log('ADDING TRADES TO EXISTING....', listOfOrdersByIOU[issCCY].issuer, issCCY)
                // if the issuer of these trades is the one we searched for, append them to any already found live.  Otherwise, ignore the trades and put their issuer into the needs history list
                //* we may already have these from the other side of the trade previous get (eg. get LOX, returns LOX/XRP and SOLO/LOX, then get SOLO, returns SOLO/LOX and SOLO/XRP; SOLO/LOX added twice to trades list wrongly)
                //* PUSH ONTO TRADES ONLY THOSE TRADES WE HAVEN'T SEEN ALREADY SOMEWHERE (by TXID)

                //* OLD:  listOfOrdersByIOU[issCCY].trades.push(...obj.trades)   
               
                
                
               
                const tradesToPush = obj.trades.filter(t => !globalTxList.includes(t.tx))
                console.log('PUshing these trades', tradesToPush.length)
                listOfOrdersByIOU[issCCY].trades.push(...tradesToPush.map(t => ({...t, _fromGetter: true})))
                
                // fs.writeFileSync('./aftermerge_'+msg.block_trades.issuer + '_' + Date.now() +'.json', JSON.stringify(listOfOrdersByIOU[issCCY], null, 2))
                
            } else {
                // make the entry fresh
                // console.log('FRESH NEW ENTRY FOR TRADES', obj.issuer, issCCY)
                listOfOrdersByIOU[issCCY] = {...obj, trades: obj.trades.map(t => ({...t, _fromGetter: true}))}
            }




            // work out the fxusd value of the base amount of the trade, using the priceOracle.history records
            listOfOrdersByIOU[issCCY].trades.filter(t => t._fromGetter == true && t.fxusd == undefined).forEach(event => {
    
                // defualt to 0 value so doesn't recompute on error
                event.fxusd = 0

                let poRate = priceOracle.history.find(h => h.ledger_index > event.lv)
                if (poRate == undefined) {
                    poRate = {
                        ledger_index: event.lv,
                        usd_rate: 0     // price feed not found for this ledger
                    }
                    // fs.appendFileSync('./NO_PRICE_ORACLE_FOR_LEDGER.json', JSON.stringify(event, null, 2))
                }

                if (event.op.ccy == 'XRP') {
                    event.fxusd = poRate.usd_rate  * event.op.am;
                } else
                if (event.op.ccy == 'USD') {
                    event.fxusd = event.op.am
                } else
                if (event.ccy == 'USD') {
                    event.fxusd = event.am
                } else {
                    // look up base against XRP in the recent trades list, see if we have an average rate over the last X minutes, use that to get an implied rate for this pair going forwards

                    // console.log(`**** ${event.iss + '.' + event.ccy} VS ${event.op.cp + '.' + event.op.ccy}`)

                    let useRatesFrom = null
                    let usedSide = null
                    if (listOfOrdersByIOU[event.iss + '.' + event.ccy] && listOfOrdersByIOU[event.iss + '.' + event.ccy]['trades'] && listOfOrdersByIOU[event.iss + '.' + event.ccy]['trades'].length > 0) {
                        useRatesFrom = listOfOrdersByIOU[event.iss + '.' + event.ccy].trades.filter(t => t.op.ccy == 'XRP' && t.lv <= poRate.ledger_index)
                        usedSide = 'base'
                        // console.log('using base')
                    } else
                    if (listOfOrdersByIOU[event.op.cp + '.' + event.op.ccy] && listOfOrdersByIOU[event.op.cp + '.' + event.op.ccy]['trades'] && listOfOrdersByIOU[event.op.cp + '.' + event.op.ccy]['trades'].length > 0) {
                        useRatesFrom = listOfOrdersByIOU[event.op.cp + '.' + event.op.ccy].trades.filter(t => t.op.ccy == 'XRP' && t.lv <= poRate.ledger_index)
                        usedSide = 'quote'
                        // console.log('using quote')
                    } else {
                        console.log('CANT USE ANYTHING')
                    }

                    if (useRatesFrom != null) {
                        // make temp array of just ts and rate, and sort DESC by ts
                        const ratesToUse = useRatesFrom.map(t => ({ts: t.ts, rate: t.rate})).sort((a, b) => {
                            if (a.ts < b.ts) {
                                return 1;
                            }
                            if (a.ts > b.ts) {
                                return -1;
                            }
                            return 0;
                        })
                        // now filter by last 3 trades for avg rate (crude but will do for approximation of rate)
                        .slice(0, 3)
                        // console.log('RATES TO USE IS', ratesToUse, ratesToUse.length)
                        // now find the avg of the rates
                        const sumRates = ratesToUse.reduce((cum, val) => cum + val.rate, 0)
                        // console.log('SUMRATES: ', sumRates)
                        const avgRate = sumRates / ratesToUse.length
                        // console.log('AVERAGE RATE IS', avgRate)
                        // apply this rate in the correct direction depending on if it is base or quote we are having to use
                        if (usedSide == 'base') {
                            event.fxusd = event.am * avgRate * poRate.usd_rate 
                        } else {
                            event.fxusd = (event.op.am * avgRate) * poRate.usd_rate 
                        }
                        // console.log('FXUSD equiv is ', event.fxusd, event)
                    }
                }
            })

            // mark this issuer as having it's 24hr data retrieved now
            if (msg.block_trades.issuer == listOfOrdersByIOU[issCCY].issuer) {
                listOfOrdersByIOU[issCCY].has24hr = true
            }

            // if the issuer is not in the for-history-get list yet, add it and request it
            if (issuersForHistoryGet[obj.issuer] == undefined) {
                // add the entry now
                issuersForHistoryGet[obj.issuer] = {
                    needed: true,
                    requested: false,
                    ledger_upto: firstLedgerTxProcessedValid.ledger_index - 1
                }
            }

            
        })


        // if there are NO TRADES in the history search period we still need to UNBLOCK those entries we've already got for it
        // (so the spinner doesn't show on front-end website because it thinks it hasn't got the history yet)
        issuersForHistoryGet[msg.block_trades.issuer].has24hr = true
        Object.values(listOfOrdersByIOU).filter(o => o.issuer == msg.block_trades.issuer).forEach(i => i.has24hr = true)
    
    }
}



// this is called on fork exit, to reset global child var ready for next use
const childExit24Getter = () => {
    console.log('childExit24Getter executing.')
    child24Getter = null
}







// this proc processes incoming fork data from child process gathering pair information (obligation/market price/kyc)
const childMessagePairGetter = (msg) => {
    console.log('INCOMING Message from PairGetter.')
    console.dir(msg, {depth: null})
   
    if (msg.prices) {
        msg.prices.forEach(p => {
            const pair = listOfRates.find(r => r.base.issuer == p.base.issuer && r.base.ccy == p.base.ccy && r.quote.issuer == p.quote.issuer && r.quote.ccy == p.quote.ccy)
            if (pair == undefined) {
                listOfRates.push({
                    // lastCheckedLedger: 0,
                    base: p.base,
                    quote: p.quote,
                    prices: p.prices,
                })
            } else {
                pair.prices = p.prices
            }
        })
    }

    if (msg.obligations) {
        msg.obligations.forEach(ob => {
            if (listOfObligationsByIssuer[ob.issuer] == undefined) {
                listOfObligationsByIssuer[ob.issuer] = {ccy: {}, mcap: {}, pricefx: {}, kyc: null}
            }
            // set KYC received data if we have it
            listOfObligationsByIssuer[ob.issuer].kyc = listOfObligationsByIssuer[ob.issuer].kyc === true ? listOfObligationsByIssuer[ob.issuer].kyc : msg['kyc'] && msg.kyc[ob.issuer]
            // console.log('KYC for issuer', ob.issuer, listOfObligationsByIssuer[ob.issuer].kyc)

            if (listOfObligationsByIssuer[ob.issuer].ccy[ob.ccy] == undefined) {
                listOfObligationsByIssuer[ob.issuer].ccy[ob.ccy] = 0
            }
            listOfObligationsByIssuer[ob.issuer].ccy[ob.ccy] = +ob.obligation

            // calculate market cap on a issuer.ccy basis
            if (listOfObligationsByIssuer[ob.issuer].mcap[ob.ccy] == undefined) {
                listOfObligationsByIssuer[ob.issuer].mcap[ob.ccy] = 0
            }
            
            if (listOfObligationsByIssuer[ob.issuer].pricefx[ob.ccy] == undefined) {
                listOfObligationsByIssuer[ob.issuer].pricefx[ob.ccy] = 0
            }




            // MARKET CAP calculation
            // FIRST, look up the currency against XRP and find all it's recent trades recorded for the most accurate price conversion
            // IF no XRP traded pair, look at the most volumous traded pair instead and convert whatever that counter-ccy is to XRP, and use that conversion

            
            // look up base against XRP in the recent trades list, see if we have an average rate over the last X minutes, use that to get an implied rate for this pair going forwards

            const pair = listOfRates.find(r => r.base.issuer == ob.issuer && r.base.ccy == ob.ccy && r.quote.issuer == undefined && r.quote.ccy == 'XRP')
            if (pair != undefined && pair['prices']) {
                listOfObligationsByIssuer[ob.issuer].pricefx[ob.ccy] = (pair.prices['mid'] || 0) * priceOracleFeed['XRP/USD']
                listOfObligationsByIssuer[ob.issuer].mcap[ob.ccy] = +ob.obligation * listOfObligationsByIssuer[ob.issuer].pricefx[ob.ccy]
            }

        })
    }

    // reset var ready for next use
    childPairGetterWaiting = false
    console.log('childPairGetterWaiting is now', childPairGetterWaiting)
}



// resets child var on fork exit ready for next use
const childExitPairGetter = () => {
    console.log('childExitPairGetter executing.')
    childPairGetter = null
    childPairGetterWaiting = false
}






// ================================================================
// ENTRY POINT
// ================================================================
const main = async() => {

    let client = null

    const cmd_line_arguments = getArgs()
    console.dir(cmd_line_arguments)



    if (cmd_line_arguments.args['justserver'] == true) {
        // start the websocket server ready to send info to connected clients
        initWebsocketServer({
            '/token-volume': () => wsPublishTokenVolume(true),
            '/token-list': () => wsPublishTokenList(true),
        })

        return
    }



    // load saved data in first
    try {
        if (cmd_line_arguments.args['ignore'] != true) {
            ({
                firstLedgerTxProcessedValid,
                last_ledger_index, 
                listOfOrdersByIOU, 
                listOfObligationsByIssuer,
                listOfRates,
                issuersForHistoryGet,
                priceOracle,
            } = JSON.parse(fs.readFileSync('./listOfOrdersByIOU.json')))
        }

        if (firstLedgerTxProcessedValid == undefined) firstLedgerTxProcessedValid = null
        if (listOfObligationsByIssuer == undefined) listOfObligationsByIssuer = {}
        if (listOfRates == undefined) listOfRates = []
        if (issuersForHistoryGet == undefined) issuersForHistoryGet = {}
        if (priceOracle == undefined) {
            priceOracle = {
                has24hours: false,
                history: []
            }
        }


        // if we want to force a catchup to a given ledger idx, set arguments --catchup=<ledger_index_to_catchup_to>
        if (cmd_line_arguments.args['catchup']) {
            last_ledger_index = +cmd_line_arguments.args['catchup']  //67012106
        }




        // if any issuer.base of listOfOrdersByIOU is not in listOfObligationsByIssuer, set listOfObligationsByIssuer
        Object.values(listOfOrdersByIOU).forEach(el => {
            if (listOfObligationsByIssuer[el.issuer] == undefined) {
                listOfObligationsByIssuer[el.issuer] = {ccy: {}, mcap: {}, pricefx: {}, kyc: null}
            }
            if (listOfObligationsByIssuer[el.issuer].ccy[el.currency] == undefined) {
                listOfObligationsByIssuer[el.issuer].ccy[el.currency] = 0
                listOfObligationsByIssuer[el.issuer].lastCheckedLedger = 0
            }
            if (listOfObligationsByIssuer[el.issuer].mcap[el.currency] == undefined) {
                listOfObligationsByIssuer[el.issuer].mcap[el.currency] = 0
            }
            if (!listOfObligationsByIssuer[el.issuer].pricefx) listOfObligationsByIssuer[el.issuer].pricefx = {}
            if (listOfObligationsByIssuer[el.issuer].pricefx[el.currency] == undefined) {
                listOfObligationsByIssuer[el.issuer].pricefx[el.currency] = 0
            }
        })

        // compose issuerCurrencies from listOfObligationsByIssuer
        Object.keys(listOfObligationsByIssuer).forEach(issuer => {
            issuerCurrencies[issuer] = {}
            Object.keys(listOfObligationsByIssuer[issuer].ccy).forEach(ccy => {
                issuerCurrencies[issuer][ccy] = true
            })
        })


        if (listOfOrdersByIOU === undefined) {
            listOfOrdersByIOU = {}
        }
        if (last_ledger_index === undefined) {
            last_ledger_index = 0
        }

        console.log('SAVED FILE PARSED OK.')

    } catch(err) {
        console.log('Could Not Load JSON database file, continuing fresh...')
        last_ledger_index = 0
        listOfOrdersByIOU = {}
    }


    




    // set up the fork of tx pair getter ready to get price/obligation/kyc data on request
    childPairGetter = setupFork({
        program: path.resolve('tx-pair-getter.js'),
        onMessageFn: childMessagePairGetter,
        onExitFn: childExitPairGetter,
    })



    // did we save a last ledger?  If so, we need to run a process to "catch up" on all transactions from that one forward 
    // (including that one, by removing tx already recorded for that one and re-getting them incase the process quit right in the middle of processing that ledger's txs)
    live_monitoring_enable = false
    catchup_success = false

   
    if (client === null) {
        console.log('SETTING UP CLIENT...')
        client = new XrplClient([
            // "wss://xrpl.link"
            "wss://s1.ripple.com"   // seems more stable without reconnects
        ]);
    }
    

    

    client.on("transaction", async(tx) => {
        // dont process if this tx is from a ledger less than or equal to the last one we are catching up to
        if (tx.ledger_index <= catchup_to_ledger_index) return
        // it it successful?
        if (tx.engine_result != 'tesSUCCESS') return
        // we can process this tx
        // first, push onto the stack to process later
        liveTxStack.push(tx);
        // attempt to process one tx at a time
        // wait until catchup is fully done before we process anything from the stack
        if (!live_monitoring_enable) return
        processTxStack(client);
    });





    client.on("ledger", async (ledger) => {
        // record the last index
        ledger_index_last = current_ledger_index
        // update the current index
        current_ledger_index = ledger.ledger_index

        // if there is a gap in ledgers received, flag it in the logs
        if (ledger_index_last > 0 && (current_ledger_index - ledger_index_last !== 1)) {
            // push the catchup requirements for this gap onto the stack
            skippedNeedsCatchup.push({
                fromInc: ledger_index_last,
                toInc: current_ledger_index-1
            })
            // log it
            fs.appendFileSync('./DISCONNECTS.txt', `>>>>> ledger skip detected at ${Date()}, was ${ledger_index_last}, now ${current_ledger_index}, skippedNeedsCatchup array is \n` + JSON.stringify(skippedNeedsCatchup, null, 2))
        }

        // do we need to do any catchups?
        if (live_monitoring_enable && skippedNeedsCatchup.length > 0) {
            // yes, so slice the first requirement off the top and kick off the process to catchup
            const catchUpNeeded = skippedNeedsCatchup.shift()
            initializeCatchup(client, catchUpNeeded.fromInc, catchUpNeeded.toInc)
        }


        // debug stuff
        if (need_ledger_index_after_reconnect === true) {
            need_ledger_index_after_reconnect = false
            ledger_index_after_reconnect.push({
                when: Date(),
                ledger: current_ledger_index
            })
        }

        // console.log("ledger", ledger);
        //fs.writeFileSync('./listOfOrdersByIOU.json', JSON.stringify(listOfOrdersByIOU, null, 2)) 


        // re-calculate basic stats now from all the gathered info
        await calculateRunningTotals()

        // push whole dataset(s) to connected clients if anything has changed (needs optimisation for bandwidth reduction)
        console.log('>>>>>>>>>> WS PUSH NOW....')
        await wsPublishTokenVolume() 
        await wsPublishTokenList() 



        // send request to orderbook price getter on each ledger event, if we have any pairs processed that need it
        if (!childPairGetterWaiting && live_monitoring_enable && batchPairsAffectingOrderBooks.length > 0) {
            console.log('sending PRICE pair data request to getter... childPairGetterWaiting=', childPairGetterWaiting)
            const pairsForGetting = clone(batchPairsAffectingOrderBooks)
            // zero it for next time
            batchPairsAffectingOrderBooks = []
            // send the request off
            childPairGetterWaiting = true
            childPairGetter.send({
                get_price: {
                    pairs: pairsForGetting.map(r => ({
                        base: {
                            issuer: r.issuer,
                            ccy: r.ccy,
                            kyc: listOfObligationsByIssuer[r.issuer]?.kyc
                        },
                        quote: {
                            issuer: r.op['issuer'],
                            ccy: r.op.ccy,
                            kyc: r.op['issuer'] && listOfObligationsByIssuer[r.op['issuer']]?.kyc
                        },
                    })),
                    ledger_index: ledger.ledger_index,
                },
            })
        }
    });

    client.on("retry", (a) => {
        console.log("retry", a);
        need_ledger_index_after_reconnect = true
        fs.appendFileSync('./DISCONNECTS.txt', `RETRY at ${Date()} with current_ledger_index ${current_ledger_index}\n`)
    });

    client.on("close", (a) => {
        console.log("close", a);
        need_ledger_index_after_reconnect = true
        fs.appendFileSync('./DISCONNECTS.txt', `CLOSE at ${Date()} with current_ledger_index ${current_ledger_index}\n`)
    });

    client.on("state", (a) => {
        console.log("state", a);
        fs.appendFileSync('./DISCONNECTS.txt', `STATE at ${Date()} with current_ledger_index ${current_ledger_index} STATE.online of ${a.online}\n`)
    });

    client.on("nodeswitch", (a) => {
        console.log("nodeswitch", a)
    });
    client.on("online", (a) => {
        console.log("online", a)
        need_ledger_index_after_reconnect = true
        fs.appendFileSync('./DISCONNECTS.txt', `ONLINE at ${Date()} with current_ledger_index ${current_ledger_index}\n`)
    });
    client.on("offline", (a) => {
        console.log("offline", a)
        need_ledger_index_after_reconnect = true
        fs.appendFileSync('./DISCONNECTS.txt', `OFFLINE at ${Date()} with current_ledger_index ${current_ledger_index}\n`)
    });
    client.on("round", (a) => {
        console.log("round", a)
    });
    client.on("reconnect", (a) => {
        console.log("reconnect", a)
    });


    // launch the XRPL-client instance now and wait till it connects
    await client.ready();
    console.log('CLIENT READY.')

    // live tracking on transactions from this point onwards is now enabled - they will be pushed onto the stack and processed when we are ready later.
    // We need to do a few more things first...

    // get the starting XRP/USD price from this ledger onwards
    const priceOracleData = await client.send({
        command: 'account_lines',
        account: 'rXUMMaPpZqPutoRszR29jtC8amWq3APkx',
        ledger_index: "validated"
    });
    priceOracleFeed['XRP/USD'] = +priceOracleData.lines.filter(l => l.currency === 'USD')[0].limit
    priceOracle.history.push({
        ledger_index: priceOracleData.ledger_index,
        usd_rate: priceOracleFeed['XRP/USD']
    })
    console.log('STARTING PRICE: ', priceOracleFeed)




    // look through all issuerObligations and work out those who we haven't got data for - a good indicator is the kyc status being undefined
    const kycNeededForPairs = Object.entries(listOfObligationsByIssuer).filter(([iss, obj]) => obj.kyc === undefined).reduce((acc, [iss, obj]) => {
        // console.log(acc, iss, obj)
        //acc.push(iss)
        acc.push({
            base: {
                issuer: iss
            }
        })
        return acc
    }, [])
    console.dir(kycNeededForPairs)
        
    if (kycNeededForPairs.length > 0) {
        childPairGetterWaiting = true
        childPairGetter.send({
            get_price: {
                pairs: kycNeededForPairs
            },
        })
    }


    // if the last_ledger saved is valid, we need to do catch up to the current ledger and live track enable after the catchup ledger +1
    if (last_ledger_index > 0) {

        console.log('LAST LEDGER SAVED WAS ', last_ledger_index)
        // get current ledger we need to catch up to as an intial ending ledger
        const serverInfo = await client.send({ command: "server_info" });
        // console.log({ serverInfo });
        console.log('CURRENT LEDGER IS ', serverInfo.info.validated_ledger.seq)
        catchup_to_ledger_index = serverInfo.info.validated_ledger.seq
 
        // start the catchup now, and wait till it's done
        await initializeCatchup(client, last_ledger_index, catchup_to_ledger_index, true)

    } else {

        // there is no catchup to perform because we are starting fresh, so just go straight to live monitoring
        catchup_to_ledger_index = 0
        live_monitoring_enable = true
        enableLiveTxTracking({client})

    }
    

    // start the websocket server ready to send info to connected clients
    initWebsocketServer({
        '/token-volume': () => wsPublishTokenVolume(true),
        '/token-list': () => wsPublishTokenList(true),
    })
}


// trigger the entry point
main()



