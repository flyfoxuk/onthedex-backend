// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


/*
    This process is forked from the main process to gather price info (ie. latest order book entries) whenever a tx that affects the order book of 
    a given pairing is detected.  This ensures the unit price for a given pair is always up-to-date - any OfferCreates or OfferCancels will
    call this process to ensure the latest price data is returned to calling process.

*/


// this program is forked from main.js to obtain latest price info from an array of pairs (all pairs shown in the master list of 24 hours)

const { XrplClient } = require("xrpl-client");
const { getOrderBook, getIssuerObligations } = require('./helpers/xrpl-helpers.js')
const { getXummKyc } = require('./helpers/xumm-helpers.js')

const { getArgs } = require('./helpers/arguments.js')




const ascii_to_hex = (str) => {
    if (str.length > 3) {
        var arr1 = [];
        for (var n = 0, l = str.length; n < l; n ++) 
            {
            var hex = Number(str.charCodeAt(n)).toString(16);
            arr1.push(hex);
            }
        return arr1.join('').toUpperCase().padEnd(40, '0');
    } else {
        return str
    }
}




const getOrderBookPrice = async(client, pairing, ledgerIndex) => {

    // console.log(`GOB `, pairing, ledgerIndex)
    
    // console.log('>>>>>>>>>>>>>>> looking for ORDER BOOKS for ', pairing.base, pairing.quote)
    const price = await getOrderBook(client, ledgerIndex, {
        issuer: pairing.base.issuer,
        currency: pairing.base.ccy,
    },
    {   
        issuer: pairing.quote.issuer,
        currency: pairing.quote.ccy,
    })
    
    if (price) {
        // console.log('PRICE FOUND:')
        // console.dir(price)
        return {
            bid : price.bid,
            ask : price.ask,
            mid : price.mid,
            spr : price.ask - price.bid
        }
    } else {
        return null
    }

}



const inboundInstruction = async(message) => {
    if (message.get_price) {
        // for each pair, get latest order book pricing
        let priceDataAll = []
        for (const pairing of message.get_price.pairs.filter(p => p.quote)) {
            const priceData = await getOrderBookPrice(client, pairing, message.get_price.ledger_index)
            priceDataAll.push({
                base: pairing.base,
                quote: pairing.quote,
                prices: priceData
            })
        }

        // also get issuer obligations by each unique issuer
        const issuer_obligations = []
        const issuers = message.get_price.pairs.reduce((acc, val) => {
            acc[val.base.issuer] = {
                kyc: val.base['kyc']
            }
            if (val.quote && val.quote.issuer) {
                acc[val.quote.issuer] = {
                    kyc: val.quote['kyc']
                }
            }
            return acc
        }, {})
        for (const iss of Object.keys(issuers)) {
            const obs = await getIssuerObligations(client, iss, message.get_price.ledger_index)
            if (obs && obs['obligations']) {
                Object.keys(obs.obligations).forEach(ccyCode => {
                    issuer_obligations.push({
                        issuer: iss,
                        ccy: ccyCode,
                        obligation: +obs.obligations[ccyCode]
                    })
                })
            }
        }

        // if we haven't found KYC yet on this issuer, query XUMM for it now.  (KYC flag in XUMM is always on once set, can't be undone, so just check once per issuer)
        // TODO - needs work - if false, we recheck (which is valid) - but if issuing account is blackholed, we can avoid this check altogether once we have a FALSE from Xumm,
        // TODO - as it can't possibly become KYCed again!  - FURTHER THOUGHT - might not be true - could be KYC'd even after blackholing - KYC process (currently) does not need
        // TODO - any tx activity from the account?
        const issuer_kyc = {}
        for (const [iss, val] of Object.entries(issuers).filter(([issuer, obj]) => obj['kyc'] !== true)) {
            // console.log('Getting KYC for ', iss)
            const kyc = await getXummKyc(iss)
            // console.log('KYC for ', iss, 'is', kyc)
            if (kyc !== undefined) {
                issuer_kyc[iss] = kyc
            }
        }
    

        
        
        // console.log('priceData got is ', priceDataAll)
        try {
            process.send({prices: priceDataAll, obligations: issuer_obligations, kyc: issuer_kyc})
        } catch(err) {
            console.log('RESULT IS: ')
            console.dir({prices: priceDataAll, obligations: issuer_obligations, kyc: issuer_kyc}, {depth: null})
        }
    }
}



const main = async() => {    
    client = new XrplClient(
        ['wss://s1.ripple.com'], 
        {}
    );
    await client.ready();

    const cmd_line_arguments = getArgs()
    if (cmd_line_arguments.args['base'] && cmd_line_arguments.args['quote']) {
        // split on . and make into hex
        const pairing = {
            base: {
                issuer: cmd_line_arguments.args['base'].split('.').find(t => t.startsWith('r')),
                ccy: ascii_to_hex(cmd_line_arguments.args['base'].split('.').find(t => !t.startsWith('r'))),
            },

            quote: {
                issuer: cmd_line_arguments.args['quote'].split('.').find(t => t.startsWith('r')),
                ccy: ascii_to_hex(cmd_line_arguments.args['quote'].split('.').find(t => !t.startsWith('r'))),
            }
        }

        console.log(pairing)

        const messageToUse = {
            get_price: {
                pairs: [
                    {
                        ...pairing
                    }
                ],
                ledgerIndex: 'validated'
            }
        }

        await inboundInstruction(messageToUse)
        process.exit()
    }


    // when we have a message sent to this fork process, deal with it
    process.on('message', inboundInstruction);

    console.log('client is ready')
    try {
        process.send({ready: true})
    } catch(err) {
        //
    }



}

main();


