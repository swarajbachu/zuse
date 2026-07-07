const expo = require("eslint-config-expo/flat");

module.exports = [
  ...expo,
  {
    ignores: ["dist/**", ".expo/**"]
  }
];
