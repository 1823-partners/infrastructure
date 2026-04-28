// SWA Function proxy → Beacon. Configuration comes from SWA app settings:
//   BEACON_URL, DB_ENV, APP_NAME, BEACON_USER_TOKEN_ID/_SECRET,
//   BEACON_APP_TOKEN_ID/_SECRET. See @1823-partners/swa-proxy README.
const { createBeaconProxy } = require('@1823-partners/swa-proxy');

module.exports = createBeaconProxy();
