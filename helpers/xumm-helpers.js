// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


const axios = require('axios');



const getXummKyc = async(issuer) => {
    try {
        const data = await axios.get('https://xumm.app/api/v1/platform/kyc-status/' + issuer).then(response => response.data)
        return (data && data.account == issuer ? data.kycApproved : undefined)
    } catch(err) {
        console.error('ERROR getting XUMM kyc info for', issuer, err)
        return undefined
    }
}


module.exports = {
    getXummKyc,
}



