const mongoose = require('mongoose');

module.exports = function connectDB() {
  const uriRaw = process.env.MONGO_URI || process.env.MONGODB_URI;
  // fix common typo seen in deploy: "sretryWrites" instead of "retryWrites"
  const uri = uriRaw && uriRaw.replace(/s?retryWrites=/i, 'retryWrites=');
  if (!uri) {
    console.error('MONGO_URI or MONGODB_URI is not set. Set one of these environment variables.');
    process.exit(1);
  }

  mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => {
      console.error('MongoDB connection error', err);
      process.exit(1);
    });
};
