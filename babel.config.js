module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // VisionCamera's frame callback runs off the JS thread as a worklet (Mimic's useMimic). MUST stay last.
  plugins: ['react-native-worklets/plugin'],
};
