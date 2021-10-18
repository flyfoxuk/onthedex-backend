// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


const axios = require('axios');



const getXummKyc = async(issuer) => {
    const data = await axios.get('https://xumm.app/api/v1/platform/kyc-status/' + issuer).then(response => response.data)
    return (data && data.account == issuer ? data.kycApproved : undefined)
}


module.exports = {
    getXummKyc,
}



