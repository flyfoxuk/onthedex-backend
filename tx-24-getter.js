// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!

/*
    This process is forked from the main backend to gather historical trades between 2 dates for a given issuer.
    It is invoked by the main process at any point when we have a new trade detected live but no historical data
    for that issuer yet.
        - compute leger indexes for the start and end dates required;
        - gather trade data for that issuer between those ledger min and max times;
        - return the trade data to calling process
        - quit ready for next invocation
*/


const fs = require('fs');
const { XrplClient } = require("xrpl-client");
const { getArgs } = require('./helpers/arguments.js')

const { rippleToUnixTimestamp, findLedgerIndexForDate, findTradesBetweenLedgersAsync } = require('./helpers/xrpl-helpers.js')


// global xrpl client connection
let client

// global stack of issuers to get 24-hour order data for
let stackOfIssuers = []
let processingIssuer = null




const processStackOfIssuers = () => {
    // make sure we are not processing something already
    if (processingIssuer == true) {
        console.log('skipping processStackOfIssuers because processingIssuer = true')
        return
    }
    if (stackOfIssuers.length == 0) return

    // set the fact we are processing now so we don't keep calling ourselves
    processingIssuer = true
    
    // get the 0 index item at the top of the stack
    const issuerEntry = stackOfIssuers[0]

    // return a promise once all data gathering complete
    return new Promise((resolve, reject) => {

        // find the details on the max ledger we want to gather data up to and including
        client.send({
            command: 'ledger',
            ledger_index: issuerEntry.ledger_max,
            full: false,
            accounts: false,
            transactions: false,
            expand: false,
            owner_funds: false
        }).then(ledger_request => {
            // convert ledger index and times into useful vars
            const startingLedgerObj = {
                ledger_index: ledger_request.ledger_index,
                close_time: ledger_request.ledger.close_time,
                close_time_unix: rippleToUnixTimestamp(ledger_request.ledger.close_time),
            }

            // now find the 24-hrs ago ledger from this ledger
            findLedgerIndexForDate(client, startingLedgerObj.close_time_unix - (24*60*60*1000), startingLedgerObj).then(targetLedgerBack => {
                // set the ledger min/max parameters for getting the 24hr block of trades
                const paramsForGetter = {
                    ledgerMin: targetLedgerBack.target_ledger_index,
                    ledgerMax: startingLedgerObj.ledger_index,
                    issuer: issuerEntry.issuer
                }
                // console.log('PARAMS FOR THE GETTER ', paramsForGetter)

                // get all trades for this issuer between these ledger indexes
                findTradesBetweenLedgersAsync(client, paramsForGetter).then(all_trades => {
                    // once we have it, say so
                    console.log('GETTER: got all_trades for ', issuerEntry.issuer)
                    // pass it back to the parent
                    console.log('Sending trades to parent...')
                    try {
                        const sendResult = process.send({
                            block_trades: {
                                issuer: issuerEntry.issuer,
                                trades: all_trades
                            }
                        })
                    } catch(err) {
                        // maybe we are calling direct from command line so process.send won't work, in which case trap and output to console
                        console.error('CANNOT DO PROCESS.SEND SO HERES THE OUTPUT:')
                        console.dir({block_trades: {
                            issuer: issuerEntry.issuer,
                            trades: all_trades
                        }}, {depth: null})
                    }

                    // save it
                    // fs.writeFileSync('./GET24_'+issuerEntry.issuer+'.json', JSON.stringify(all_trades, null, 2))


                    // shift this entry off the stack to process as we are done with it
                    stackOfIssuers.shift()
                    processingIssuer = false

                    // more issuers to process?  If so, call ourselves
                    if (stackOfIssuers.length > 0) {
                        processStackOfIssuers()
                    }

                    // all done, resolve now
                    resolve()

                }).catch(err => {
                    console.error('ERROR with ', err)
                    reject()
                })
            })
        }).catch(err => {
            console.error('STACK ERROR', err)
            reject()
        })
    })
}






// ==============================================================================
// MAIN proc 
// ==============================================================================
const main = async() => {

    // get command line arrguments
    const cmd_line_arguments = getArgs()
    console.dir(cmd_line_arguments)

    
    console.log('INITIALIZING GETTER CLIENT....')
    client = new XrplClient(['wss://s1.ripple.com']);  // problems with disconnects using xrplcluster or xrpl.link, so uses ripple for now

    client.on("retry", (a) => {
        console.log("retry", a);
    });

    client.on("close", (a) => {
        console.log("close", a);
        // mark it as not processing anymore
        processingIssuer = false
    });

    client.on("state", (a) => {
        console.log("state", a);
    });

    client.on("nodeswitch", (a) => {
        console.log("nodeswitch", a)
    });
    client.on("online", (a) => {
        console.log("online", a)
        processingIssuer = false
    });
    client.on("offline", (a) => {
        console.log("offline", a)
    });
    client.on("round", (a) => {
        console.log("round", a)
    });
    client.on("reconnect", (a) => {
        console.log("reconnect", a)
    });
    

    console.log('calling await client.ready()')
    await client.ready();
    console.log('GETTER CLIENT READY.....')


    // debug timer to check we haven't died
    setInterval(() => {
        console.log('GETTER TICKER - ', client.getState())
    }, 5000)


    // push the requested issuer and max ledger to gather data onto the stack to process
    stackOfIssuers.push({
        issuer: cmd_line_arguments.args['issuer'],
        ledger_max: cmd_line_arguments.args['ledger-max']
    })

    // async call the processing of the stack items now
    processStackOfIssuers().then(() => {
        // processing complete, so set timer to force the exit of the process allowing time for process.send to complete reliably
        console.log('resolved, setting exit timer...')
        setInterval(() => {
            console.log('destroying connection...')
            client.destroy();
            console.log('getter done, over and out, exiting here')
            process.exit();
        }, 4000)  // arbitary 4sec wait for process.send (could be much lower)
    }).catch(err => {
        console.error('CAUGHT processStackOfIssuers ERROR:', err)
        process.exit();
    });
}


// trigger main proc on entry
main()