const mongoose = require('mongoose');

module.exports = function connectDB() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI or MONGODB_URI is not set. Set one of these environment variables.');
    process.exit(1);
  }

  mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => {
      console.error('MongoDB connection error', err);
      // exit so the platform shows a failed deploy instead of running with a broken DB
      process.exit(1);
    });
};
