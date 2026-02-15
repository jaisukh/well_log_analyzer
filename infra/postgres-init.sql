CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
    'curve_samples',
    'depth',
    if_not_exists => TRUE
);

