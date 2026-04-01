-- 01-create-databases.sql
-- Runs once on first container start (PostgreSQL initdb hook).
--
-- The ouija_db database is already created by the POSTGRES_DB environment
-- variable. This script creates plane_db for the full-stack compose and
-- restricts cross-database access so the ouija role cannot query plane_db.
--
-- The \gexec idiom avoids an error if the database already exists.

-- Create plane_db if it does not already exist.
SELECT 'CREATE DATABASE plane_db'
  WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname = 'plane_db'
  )\gexec

-- Restrict the ouija role: revoke the default CONNECT privilege on plane_db.
-- This prevents accidental or malicious cross-database queries from Ouija's
-- connection pool.
REVOKE ALL ON DATABASE plane_db FROM ouija;
