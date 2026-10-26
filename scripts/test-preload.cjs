const os = require('node:os');
os.userInfo = () => ({
  uid: -1,
  gid: -1,
  username: process.env.USERNAME || 'asguard-test-runner',
  homedir: os.homedir(),
  shell: null,
});
