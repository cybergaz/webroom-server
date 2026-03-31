const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const env = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',

  db: {
    url: required('DATABASE_URL'),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  },

  redis: {
    url: required('REDIS_URL'),
  },

  getstream: {
    apiKey: required('GETSTREAM_API_KEY'),
    apiSecret: required('GETSTREAM_API_SECRET'),
    callType: process.env.GETSTREAM_CALL_TYPE ?? 'audio_room',
  },

  s3: {
    bucket: required('S3_BUCKET'),
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    endpoint: process.env.S3_ENDPOINT || undefined,
  },
} as const;
