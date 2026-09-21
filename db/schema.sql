-- Yield analytics schema (SQL Server 2022 / Azure SQL compatible).
-- Idempotent: safe to run on every simulator start.

IF DB_ID('yield') IS NULL CREATE DATABASE yield;
GO
USE yield;
GO
IF SCHEMA_ID('mfg') IS NULL EXEC('CREATE SCHEMA mfg');
GO

IF OBJECT_ID('mfg.step') IS NULL
CREATE TABLE mfg.step (
    step_id      INT          NOT NULL PRIMARY KEY,   -- routing sequence 1..50
    name         VARCHAR(80)  NOT NULL,
    area         VARCHAR(40)  NOT NULL,
    step_type    VARCHAR(12)  NOT NULL,               -- process | measurement | visual
    param_name   VARCHAR(40)  NULL,
    param_unit   VARCHAR(12)  NULL,
    lsl          FLOAT        NULL,
    target       FLOAT        NULL,
    usl          FLOAT        NULL
);

IF OBJECT_ID('mfg.defect') IS NULL
CREATE TABLE mfg.defect (
    defect_code  VARCHAR(24)  NOT NULL PRIMARY KEY,
    description  VARCHAR(120) NOT NULL,
    category     VARCHAR(24)  NOT NULL                -- tissue | frame | suture | dimensional | process
);

IF OBJECT_ID('mfg.operator') IS NULL
CREATE TABLE mfg.operator (
    operator_id  VARCHAR(8)   NOT NULL PRIMARY KEY,
    name         VARCHAR(60)  NOT NULL,
    shift        VARCHAR(8)   NOT NULL,
    hire_date    DATE         NOT NULL
);

IF OBJECT_ID('mfg.equipment') IS NULL
CREATE TABLE mfg.equipment (
    equipment_id VARCHAR(16)  NOT NULL PRIMARY KEY,
    step_id      INT          NOT NULL REFERENCES mfg.step(step_id),
    name         VARCHAR(60)  NOT NULL
);

IF OBJECT_ID('mfg.lot') IS NULL
CREATE TABLE mfg.lot (
    lot_id        VARCHAR(16) NOT NULL PRIMARY KEY,
    tissue_lot    VARCHAR(20) NOT NULL,
    frame_lot     VARCHAR(20) NOT NULL,
    released_at   DATETIME2(0) NOT NULL
);

IF OBJECT_ID('mfg.unit') IS NULL
CREATE TABLE mfg.unit (
    serial        VARCHAR(16) NOT NULL PRIMARY KEY,
    lot_id        VARCHAR(16) NOT NULL REFERENCES mfg.lot(lot_id),
    model         VARCHAR(16) NOT NULL,               -- valve size, e.g. HV-23
    started_at    DATETIME2(0) NOT NULL,
    completed_at  DATETIME2(0) NULL,
    status        VARCHAR(12) NOT NULL,               -- wip | shipped | scrapped
    first_pass    BIT         NULL                    -- completed with no fail/rework
);

IF OBJECT_ID('mfg.step_event') IS NULL
CREATE TABLE mfg.step_event (
    event_id      BIGINT      NOT NULL PRIMARY KEY,
    serial        VARCHAR(16) NOT NULL REFERENCES mfg.unit(serial),
    step_id       INT         NOT NULL REFERENCES mfg.step(step_id),
    attempt       TINYINT     NOT NULL,
    started_at    DATETIME2(0) NOT NULL,
    ended_at      DATETIME2(0) NOT NULL,
    operator_id   VARCHAR(8)  NOT NULL REFERENCES mfg.operator(operator_id),
    equipment_id  VARCHAR(16) NOT NULL REFERENCES mfg.equipment(equipment_id),
    result        VARCHAR(8)  NOT NULL,               -- pass | rework | scrap
    defect_code   VARCHAR(24) NULL REFERENCES mfg.defect(defect_code),
    CONSTRAINT uq_step_event UNIQUE (serial, step_id, attempt)
);

IF OBJECT_ID('mfg.measurement') IS NULL
CREATE TABLE mfg.measurement (
    event_id      BIGINT      NOT NULL PRIMARY KEY REFERENCES mfg.step_event(event_id),
    value         FLOAT       NOT NULL
);

IF OBJECT_ID('mfg.inspection_image') IS NULL
CREATE TABLE mfg.inspection_image (
    event_id        BIGINT      NOT NULL PRIMARY KEY REFERENCES mfg.step_event(event_id),
    image_path      VARCHAR(120) NOT NULL,
    true_class      VARCHAR(24) NOT NULL,              -- inspector disposition ('ok' or a defect_code)
    ai_class        VARCHAR(24) NOT NULL,              -- vision model prediction
    ai_confidence   FLOAT       NOT NULL,
    bbox_x FLOAT NULL, bbox_y FLOAT NULL, bbox_w FLOAT NULL, bbox_h FLOAT NULL   -- normalised 0..1
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_event_step_time')
    CREATE INDEX ix_event_step_time ON mfg.step_event(step_id, ended_at) INCLUDE (result, defect_code, equipment_id, operator_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_unit_started')
    CREATE INDEX ix_unit_started ON mfg.unit(started_at) INCLUDE (status, first_pass, model, lot_id);
GO
