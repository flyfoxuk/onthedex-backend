const formatNumber = (precision, number) => {
    if (typeof number === 'undefined' || number === null) return ''
  
    if (number === 0) return '0'
  
    const roundedValue = round(precision, number)
    const floorValue = Math.floor(roundedValue)
  
    const isInteger = Math.abs(floorValue - roundedValue) < Number.EPSILON
  
    const numberOfFloorDigits = String(floorValue).length
    const numberOfDigits = String(roundedValue).length
  
    if (numberOfFloorDigits > precision) {
      return String(floorValue)
    } else {
      const padding = isInteger ? precision - numberOfFloorDigits : precision - numberOfDigits + 1
  
      if (padding > 0) {
        if (isInteger) {
          return `${String(floorValue)}.${'0'.repeat(padding)}`
        } else {
          return `${String(roundedValue)}${'0'.repeat(padding)}`
        }
      } else {
        return String(roundedValue)
      }
    }
  }
  
  function round (precision, number) {
    return parseFloat(number.toPrecision(precision))
  }
  
  module.exports = {
      formatNumber,
  }