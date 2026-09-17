import type { NextConfig } from 'next';

const config: NextConfig = {
    // The Cephable access key is read in the route handler only. It is deliberately NOT exposed via
    // `env` or a NEXT_PUBLIC_ name — anything public ends up in the browser bundle.
    experimental: {},
};

export default config;
