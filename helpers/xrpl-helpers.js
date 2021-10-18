// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!




const transactionParser  = require('ripple-lib-transactionparser');



function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}


function rippleToUnixTimestamp(rpepoch) {
    return (rpepoch + 0x386d4380) * 1000
}

function rippleTimeToISO8601(rippleTime) {
    return new Date(rippleToUnixTimestamp(rippleTime)).toISOString()
}

function unixTimestampToRippleTime(unixTs) {
    return (unixTs / 1000) - 0x386d4380
}



const findLedgerIndexForDate = async(client, targetDate, startingLedgerObj = null) => {

    let data

    // first, get the current validated ledger index as the base reference from which we will calculate back
    let baseLedger
    if (startingLedgerObj == null) {
        data = await client.send({
            command: 'ledger',
            ledger_index: 'validated',
            full: false,
            accounts: false,
            transactions: false,
            expand: true,
            owner_funds: false,
        });

        // console.log('data:', data)

        baseLedger = {
            ledger_index: data.ledger_index,
            close_time: data.ledger.close_time,
            close_time_unix: rippleToUnixTimestamp(data.ledger.close_time),
        }
    } else {
        baseLedger = startingLedgerObj
    }

    // establish var for holding the target close time
    const targetLedger = {
        close_time: 0,
        close_time_unix: 0,
    }

    // now convert the targetDate into unix time too, if necessary
    if (typeof targetDate == 'string') {
        targetLedger.close_time_unix = Date.parse(targetDate)
    } else
    if (typeof targetDate == 'number') {
        targetLedger.close_time_unix = targetDate
    } else
    if (targetDate instanceof Date && !isNaN(targetDate)) {
        targetLedger.close_time_unix = Date.parse(targetDate.toGMTString())
    }
    // convert target to ripple time
    targetLedger.close_time = unixTimestampToRippleTime(targetLedger.close_time_unix)




    // keep asking for ledgers back and forth until we find the one that sits at or just after this target close_time
    let secondsPerLedger = 3.86 // initial best guess at ledger close time interval
    // let narrowBy = -Math.floor((minutesAgo * 60) / secondsPerLedger) // 1 day of ledgers by default to start with
    let narrowBy = -Math.floor(((baseLedger.close_time_unix - targetLedger.close_time_unix) / 1000) / secondsPerLedger)   // narrow the guess by 1 whole period, roughly, as the starting gap
    let testThisLedgerIdx = baseLedger.ledger_index  // start testing from the current ledger index, going backwards
    let lastLedgerIdx
    let lastLedgerClose
    let thisCloseTime = baseLedger.close_time   // initialize the close_time of the last found ledger to the starting ledger close_time

    let totalDiffLedgerIdx = 0
    let totalDiffSeconds = 0

    let counter = 0;


    console.log('baseLedger:')
    console.dir(baseLedger)
    console.log('targetLedger:')
    console.dir(targetLedger)

    

    // return

    do {
        counter += 1

        lastLedgerIdx = testThisLedgerIdx
        lastLedgerClose = thisCloseTime

        testThisLedgerIdx += narrowBy
        // ask for it
        // data = await client.send({
        //     command: 'ledger',
        //     ledger_index: testThisLedgerIdx
        // })
        // data = await rapi.getLedger({ledgerVersion: testThisLedgerIdx})
        data = await client.send({
            command: 'ledger',
            ledger_index: testThisLedgerIdx,
            full: false,
            accounts: false,
            transactions: false,
            expand: true,
            owner_funds: false,
        });

        // console.log(data)
        // check close time
        thisCloseTime = data.ledger.close_time
        const diff = thisCloseTime - targetLedger.close_time

        const diffLedgers = data.ledger_index - lastLedgerIdx
        const calculatedSecondsPerLedger = Math.abs(thisCloseTime - lastLedgerClose) / Math.abs(diffLedgers)

        totalDiffLedgerIdx+= Math.abs(data.ledger_index - lastLedgerIdx)
        totalDiffSeconds += Math.abs(thisCloseTime - lastLedgerClose)
        const cumulativeCalculatedSecondsPerLedger = totalDiffSeconds / totalDiffLedgerIdx

        secondsPerLedger = cumulativeCalculatedSecondsPerLedger


        console.log(`${counter} ledgerIndex of ${testThisLedgerIdx} found closeTime of ${thisCloseTime} (target=${targetLedger.close_time}) (diff=${diff}) = ${data.ledger.close_time} (spl=${calculatedSecondsPerLedger} vs ${cumulativeCalculatedSecondsPerLedger})`)

        let newNarrowBy = 0
        if (diff == 0) {
            // found it exactly!
            // do nothing else
        } else
        if (diff > 0) {
            // we are too recent, must look back further
            // recalc narrowBy
            newNarrowBy = Math.floor(-diff / secondsPerLedger)
        } else {
            // we are too early, must look forward a bit
            newNarrowBy = Math.floor(Math.abs(diff) / secondsPerLedger)
        }

        // if new calc is same as previous calc, we've reached as far as we can narrow, so use the last ledger we just got above
        if (newNarrowBy == narrowBy) {
            console.log('new calc is narrowest, abandoning here')
            narrowBy = 0
        } else {
            narrowBy = newNarrowBy
        }


    } while (narrowBy != 0 && counter < 100)


    console.log(`<<< Use this:   target_ledger_index: ${testThisLedgerIdx}>>>`)


   
    return {
        target_ledger_index: testThisLedgerIdx,
        target_ledger_close_time: data.ledger.close_time,
        target_ledger_close_time_human: data.ledger.close_time_human
    }
}






const getIssuerObligations = async(client, issuer, ledgerIdx) => {
    const data = await client.send({
        command: 'gateway_balances',
        ledger_index: ledgerIdx,
        account: issuer
    });
    return data
}






const getIssuerObligationForCcy = async(client, issuer, ccy) => {
    const data = await client.send({
        command: 'gateway_balances',
        ledger_index: 'validated',
        account: issuer
    });

    if (data) {
        return +data.obligations[ccy]
    } else {
        return false
    }
}







const getOrderBook = async(client, ledgerIdx, base, quote) => {
    /*
        .currency
        .issuer

        pays: base              gets: quote(xrp)   = bids to buy
        pays: quote(xrp)        gets: base         = asks to sell
    */

    let data
    let rateBid = 0, rateAsk = 0
    let theGet, thePay
    let firstProperOffer

    // get the highest bid
    data = await client.send({
        command: "book_offers",
        taker_gets: quote,
        taker_pays: base,
        ledger_index: ledgerIdx,
        limit: 15   // needs to be a reasonable number as some pairs have silly unfunded offers
    })
    // console.dir(data)
    // find the first offer that does NOT have taker_pays_funded==0 or taker_gets_funded==0 (or taker_gets/pays_funded.value==0)
    // ^^^^ these represent unfunded offers that cannot execute yet due to lack of funds either side, so we must ignore for now
    firstProperOffer = data.offers && data.offers.find(o => o['taker_pays_funded'] != 0 && o['taker_pays_funded']?.value != 0 && o['taker_gets_funded'] != 0 && o['taker_gets_funded']?.value != 0)
    if (firstProperOffer != undefined) {
        theGet = firstProperOffer['taker_gets_funded'] ? firstProperOffer['taker_gets_funded'] : firstProperOffer['TakerGets']
        thePay = firstProperOffer['taker_pays_funded'] ? firstProperOffer['taker_pays_funded'] : firstProperOffer['TakerPays']

        // console.dir(theGet)
        // console.dir(thePay)

        rateBid = (theGet['currency'] ? +theGet.value : +theGet/1000000) / (thePay['currency'] ? +thePay.value : +thePay/1000000)
    }

    // get the lowest ask
    data = await client.send({
        command: "book_offers",
        taker_gets: base,
        taker_pays: quote,
        ledger_index: ledgerIdx,
        limit: 15
    })
    // console.dir(data)
    firstProperOffer = data.offers && data.offers.find(o => o['taker_pays_funded'] != 0 && o['taker_pays_funded']?.value != 0 && o['taker_gets_funded'] != 0 && o['taker_gets_funded']?.value != 0)
    if (firstProperOffer != undefined) {
        theGet = firstProperOffer['taker_gets_funded'] ? firstProperOffer['taker_gets_funded'] : firstProperOffer['TakerGets']
        thePay = firstProperOffer['taker_pays_funded'] ? firstProperOffer['taker_pays_funded'] : firstProperOffer['TakerPays']
        // console.dir(theGet)
        // console.dir(thePay)
        rateAsk = (thePay['currency'] ? +thePay.value : +thePay/1000000) / (theGet['currency'] ? +theGet.value : +theGet/1000000)
    }

    return {
        bid: rateBid,
        ask: rateAsk,
        mid: rateBid > 0 && rateAsk > 0 ? (rateBid + rateAsk) / 2 : null,
    }


    /*
        "offers": [
            {
                "Account": "rG4tHmd83KJ6FFPnwzTGPDtif7UCoEdU3m",
                "BookDirectory": "6506533636CDB7474F7CA0D6013EFBC538BE58E1E575CDC1510D9001F294E5D0",
                "BookNode": "0",
                "Flags": 131072,
                "LedgerEntryType": "Offer",
                "OwnerNode": "1f5",
                "PreviousTxnID": "AC2B36410D3BE47274F62185765744A962BF3181898B0E12604493927D0FA666",
                "PreviousTxnLgrSeq": 66760031,
                "Sequence": 888393,
                "TakerGets": "43000000",
                "TakerPays": {
                    "currency": "CSC",
                    "issuer": "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr",
                    "value": "16415.304766735"
                },
                "index": "CA128CE0DD1BF0193715B768A8C43B533998334F7A665BCE00E8A6BE5877D84C",
                "owner_funds": "21331567325",
                "quality": "0.000381751273645"
            },

            {
                "Account": "rJxCoHMWge4LozGoaLtLpUQ8HfncU5Fods",
                "BookDirectory": "6506533636CDB7474F7CA0D6013EFBC538BE58E1E575CDC1510E35FA931A0000",
                "BookNode": "0",
                "Flags": 131072,
                "LedgerEntryType": "Offer",
                "OwnerNode": "0",
                "PreviousTxnID": "CCC9DE324A34F9A548268B8329510F2A9F14368F4D4FFE8F0397127CD409C4A4",
                "PreviousTxnLgrSeq": 66375849,
                "Sequence": 63441340,
                "TakerGets": "2500000000",
                "TakerPays": {
                    "currency": "CSC",
                    "issuer": "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr",
                    "value": "1000000"
                },
                "index": "B34EE7395CD55D11B4013F26F1B4C078FE8D2994E62060E433B5DD463EB987BF",
                "owner_funds": "531053626",
                "quality": "0.0004",
                "taker_gets_funded": "531053626",
                "taker_pays_funded": {
                    "currency": "CSC",
                    "issuer": "rCSCManTZ8ME9EoLrSHHYKW8PPwWMgkwr",
                    "value": "212421.4504"
                }
            },

    */

    //



}






// helper function to kick-start async gathering of data from rippled that returns paginated blocks
async function getPaginatedElements(getResourcePromise, paramsToPassObj, marker = undefined) {  //elements = []
    return new Promise((resolve, reject) =>
        getResourcePromise(paramsToPassObj, marker)
            .then(response => {
                // console.log('in getResourcePromise.then with response of ', response)
                //const newElements = elements.concat(response.records);
                if (response.marker == undefined) {
                    resolve(response.params.ptr);
                } else {
                    sleep(50).then(() => {
                        getPaginatedElements(getResourcePromise, response.params, response.marker/*, newElements*/)
                            .then(resolve)
                            .catch(reject)
                    })
                }
            }).catch(reject));
}







const findTradesBetweenLedgersAsync = (client, params) => {
    const tradeHistory = {}
    return getPaginatedElements(getAccountTxs, {client, ...params, ptr: tradeHistory}, undefined)
}



const getAccountTxs = (params, marker) => {  //client, params, ptr, marker
    return new Promise((resolve) => {

        let fetchMore = true


        console.log('****sending account_tx, marker sent is ', marker)
        params.client.send({
            command: 'account_tx',
            account: params.issuer,
            ledger_index_min: params.ledgerMin,
            ledger_index_max: params.ledgerMax,
            binary: false,
            limit: 500,
            forward: false,
            marker
        }).then(data => {
            const lineCount = data?.transactions?.length || 0

            const isMarker = data?.marker
            fetchMore = lineCount > 0 && isMarker

            console.log('Fetched # TXs:', lineCount, isMarker)
            if (lineCount == 0) {
                console.log('data recvd from rippled with lineCount zero is ');
                console.dir(data, {depth: null})
            }


            if (lineCount > 0) {
                data.transactions.forEach(async line => {
                    // is it tesSUCCESS and OfferCreate?
                    if ((line.tx.TransactionType == 'OfferCreate' || (line.tx.TransactionType == 'Payment')) && (line.meta.TransactionResult == 'tesSUCCESS')) {
                        // valid for processing
                        // console.log('BULK TX ENTRY PROCESSING FOR LEDGER', line.tx.ledger_index, line.tx.hash, params.issuer)
                        processTxMetaRecords(params.ptr, line)
                    }
                })
            }

            console.log('resolving the send with this marker:', isMarker)
            resolve({params, marker: isMarker})
        }) 
    })
}







const findPriceOracleBetweenLedgersAsync = (client, params) => {
    const poHistory = []
    return getPaginatedElements(getPriceOracleLines, {client, ...params, ptr: poHistory}, undefined)
}


const getPriceOracleLines = (params, marker) => {  //client, params, ptr, marker
    return new Promise((resolve) => {

        let fetchMore = true

        console.log('****sending account_lines, marker sent is ', marker)
        params.client.send({
            command: 'account_tx',
            account: params.issuer,
            ledger_index_min: params.ledgerMin,
            ledger_index_max: params.ledgerMax,
            binary: false,
            limit: 500,
            forward: false,
            marker
        }).then(data => {
            const lineCount = data?.transactions?.length || 0

            const isMarker = data?.marker
            fetchMore = lineCount > 0 && isMarker

            console.log('Fetched # TXs:', lineCount, isMarker)
            if (lineCount == 0) {
                console.log('data recvd from rippled with lineCount zero is ');
                console.dir(data, {depth: null})
            }

            if (lineCount > 0) {
                data.transactions.forEach(async line => {
                    
                    if ((line.tx.TransactionType == 'TrustSet') && (line.meta.TransactionResult == 'tesSUCCESS') && (line.tx.LimitAmount && line.tx.LimitAmount.currency == 'USD')) {
                        // valid for processing
                        params.ptr.push({
                            ledger_index: line.tx.ledger_index,
                            usd_rate: +line.tx.LimitAmount.value
                        })
                    }
                })
            }

            console.log('resolving the send with this marker:', isMarker)
            resolve({params, marker: isMarker})
        }) 
    })
}





const processTxMetaRecords = (ptrSaveTo, txItem) => {

    const orderbookChanges = transactionParser.parseOrderbookChanges(txItem.meta)
    // make sure there is a status='filled' or status='partially-filled' for this tx, otherwise ignore
    // console.log('obv = ', Object.values(orderbookChanges))
    const hasFilledOrders = Object.values(orderbookChanges).some(obc => obc.some(event => event.status == 'filled' || event.status == 'partially-filled'))
    if (hasFilledOrders) {

        Object.entries(orderbookChanges).forEach(entry => {
            // console.log('entry is ', entry)
            const [key, kvalue] = entry;
            kvalue.forEach(value => {
                if (['filled', 'partially-filled'].includes(value.status)) {
                    // console.log('order filled is ', value)

                    // is it sell or buy?
                    let event = {}
                    try {
                        event.ts = rippleTimeToISO8601(txItem.tx.date)   //tx.outcome.timestamp
                    }catch(err) {
                        console.log('ERROR time:')
                        console.dir(entry, {depth: null})
                        console.dir(txItem, {depth: null})
                        // console.dir(value)
                    }

                    if (value.quantity['counterparty']) {
                        event.DEBUG = 'quantity_counterparty'
                        event.ccy = value.quantity.currency
                        event.iss = value.quantity.counterparty
                        event.am = +value.quantity.value
                        event.tx = txItem.tx.hash
                        event.lv = txItem.tx.ledger_index
                        event.iil = txItem.meta.TransactionIndex
                        
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
                        console.log(`processed event in ledger`,  txItem.tx.ledger_index, `for ${event.ccy}.${event.iss}`)

                    } else
                    
                    if (value.totalPrice['counterparty']) {
                        event.DEBUG = 'totalPrice_counterparty'
                        event.ccy = value.totalPrice.currency
                        event.iss = value.totalPrice.counterparty
                        event.am = +value.totalPrice.value
                        event.tx = txItem.tx.hash
                        event.lv = txItem.tx.ledger_index
                        event.iil = txItem.meta.TransactionIndex

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
                        console.log(`processed event in ledger`,  txItem.tx.ledger_index, `for ${event.ccy}.${event.iss}`)

                    }

                    // price oracle data calc was done here but now done elsewhere
                    //...

                }
            })
        })

    }    
}





const findPriceOracleBetweenLedgers = async(client, params) => {

    /*
        .ledgerMin
        .ledgerMax
        .issuer
    */


    let fetchMore = true
    let marker = undefined

    const lines = []

    const poHistory = {}


    while (fetchMore) {
        const data = await client.send({
            command: 'account_tx',
            account: params.issuer,
            ledger_index_min: params.ledgerMin,
            ledger_index_max: params.ledgerMax,
            binary: false,
            limit: 500,
            forward: false,
            marker
        })

        const lineCount = data?.transactions?.length || 0

        marker = data?.marker
        fetchMore = lineCount > 0 && marker

        console.log('ORACLE Fetched # TXs:', lineCount, marker)

        if (lineCount > 0) {

            data.transactions.forEach(line => {
                // is it tesSUCCESS and OfferCreate?
                if ((line.tx.TransactionType == 'TrustSet') && (line.meta.TransactionResult == 'tesSUCCESS')) {
                    poHistory.push({
                        ledger_index: line.tx.ledger_index,
                        price: +tx.LimitAmount.value
                    })
                }
            })

        }
    }

    // sort by ledger_index asc
    poHistory.sort((a, b) => {
        if (a.ledger_index < b.ledger_index) {
            return 1
        } else
        if (a.ledger_index > b.ledger_index) {
            return -1
        } else {
            return 0
        }
    })

    return poHistory
}







const findAccountLinesAsync = (client, params) => {
    const accountLines = {
        holders: [],
        total: 0
    }
    return getPaginatedElements(getAccountLines, {client, ...params, ptr: accountLines}, undefined)
}




const getAccountLines = (params, marker) => {  //client, params, ptr, marker
    return new Promise((resolve) => {

        console.log('****sending account_lines, marker sent is ', marker)
        params.client.send({
            command: 'account_lines',
            account: params.issuer,
            limit: 100,
            marker
        }).then(data => {
            const lineCount = data?.lines?.length || 0

            const isMarker = data?.marker
            fetchMore = lineCount > 0 && isMarker

            console.log('Fetched # LINES:', lineCount, isMarker)
            if (lineCount == 0) {
                console.log('data recvd from rippled with lineCount zero is ');
                console.dir(data, {depth: null})
            }


            if (lineCount > 0) {
                data.lines.forEach(async line => {
                    
                    
                    //if (blockingSince + 10 > Date.now()) {
                        // await setImmediatePromise();
                    //    blockingSince = Date.now();
                    //}

                    // is it tesSUCCESS and OfferCreate?
                    if (line.currency == params.ccy) {
                        if (line.balance < 0) {
                            params.ptr.holders.push({
                                acct: line.account,
                                bal: +line.balance * -1
                            })
                        }
                        params.ptr.total += 1
                    }
                })
            }

            console.log('resolving the send, ptr count', params.ptr.length, 'with this marker:', isMarker)
            resolve({params, marker: isMarker})
        }) 
    })
}






module.exports = {
    rippleToUnixTimestamp,
    rippleTimeToISO8601,
    unixTimestampToRippleTime,
    findLedgerIndexForDate,
    getIssuerObligations,
    getIssuerObligationForCcy,

    getOrderBook,
    findTradesBetweenLedgersAsync,

    findPriceOracleBetweenLedgers,
    findPriceOracleBetweenLedgersAsync,

    findAccountLinesAsync,

}

