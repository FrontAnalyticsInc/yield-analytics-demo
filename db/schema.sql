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
    step_type    VARCHAR(12)  NOT NULL,               -- process | measurement | visual | gate
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

IF OBJECT_ID('mfg.inspection_detection') IS NULL
CREATE TABLE mfg.inspection_detection (
    event_id        BIGINT      NOT NULL REFERENCES mfg.step_event(event_id),
    idx             INT         NOT NULL,              -- the number the vision system paints on the box
    class           VARCHAR(16) NOT NULL,              -- INCLUSION | PARTICLE | THIN_SPOT | FIBER
    size_mm         FLOAT       NOT NULL,
    confidence      FLOAT       NOT NULL,
    bbox_x FLOAT NOT NULL, bbox_y FLOAT NOT NULL, bbox_w FLOAT NOT NULL, bbox_h FLOAT NOT NULL,
    PRIMARY KEY (event_id, idx)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_event_step_time')
    CREATE INDEX ix_event_step_time ON mfg.step_event(step_id, ended_at) INCLUDE (result, defect_code, equipment_id, operator_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_unit_started')
    CREATE INDEX ix_unit_started ON mfg.unit(started_at) INCLUDE (status, first_pass, model, lot_id);
GO

-- Design of experiments ----------------------------------------------------------
IF OBJECT_ID('mfg.experiment') IS NULL
CREATE TABLE mfg.experiment (
    experiment_id     INT IDENTITY(1,1) PRIMARY KEY,
    name              NVARCHAR(120) NOT NULL,
    objective         NVARCHAR(400) NULL,
    notes             NVARCHAR(MAX) NULL,
    created_by        VARCHAR(8)   NOT NULL REFERENCES mfg.operator(operator_id),
    created_at        DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    status            VARCHAR(12)  NOT NULL DEFAULT 'planned',   -- planned | running | complete | cancelled
    response_step_id  INT          NOT NULL REFERENCES mfg.step(step_id),
    sigma             FLOAT        NOT NULL,                     -- process noise used for sizing
    effect_size       FLOAT        NOT NULL,                     -- smallest change worth detecting (response units)
    alpha             FLOAT        NOT NULL,
    power_target      FLOAT        NOT NULL,
    replicates        INT          NOT NULL,                     -- per corner
    center_points     INT          NOT NULL,                     -- total centre runs
    seed              INT          NOT NULL                      -- run-order shuffle
);

IF OBJECT_ID('mfg.experiment_factor') IS NULL
CREATE TABLE mfg.experiment_factor (
    experiment_id  INT          NOT NULL REFERENCES mfg.experiment(experiment_id),
    factor_no      TINYINT      NOT NULL,                        -- 1..3, matches x1..x3 on runs
    name           NVARCHAR(60) NOT NULL,
    kind           VARCHAR(12)  NOT NULL,                        -- numeric | categorical
    units          NVARCHAR(20) NULL,
    low_value      FLOAT        NULL,                            -- numeric only
    high_value     FLOAT        NULL,
    low_label      NVARCHAR(40) NULL,                            -- categorical only
    high_label     NVARCHAR(40) NULL,
    PRIMARY KEY (experiment_id, factor_no)
);

IF OBJECT_ID('mfg.experiment_run') IS NULL
CREATE TABLE mfg.experiment_run (
    experiment_id  INT         NOT NULL REFERENCES mfg.experiment(experiment_id),
    run_no         INT         NOT NULL,                         -- randomised execution order, 1-based
    point_type     VARCHAR(8)  NOT NULL,                         -- corner | center
    replicate      TINYINT     NOT NULL,
    x1 SMALLINT NOT NULL, x2 SMALLINT NULL, x3 SMALLINT NULL,    -- coded -1 / 0 / +1; NULL when fewer factors
    PRIMARY KEY (experiment_id, run_no)
);
GO

-- single-factor experiments (x2 was NOT NULL in the first release)
IF COLUMNPROPERTY(OBJECT_ID('mfg.experiment_run'), 'x2', 'AllowsNull') = 0
    ALTER TABLE mfg.experiment_run ALTER COLUMN x2 SMALLINT NULL;
GO

-- Experiment execution: one row per run once a unit is tagged to it
IF OBJECT_ID('mfg.experiment_unit') IS NULL
CREATE TABLE mfg.experiment_unit (
    experiment_id    INT          NOT NULL,
    run_no           INT          NOT NULL,
    serial           VARCHAR(24)  NOT NULL,
    simulated        BIT          NOT NULL DEFAULT 0,
    assigned_by      VARCHAR(8)   NOT NULL REFERENCES mfg.operator(operator_id),
    assigned_at      DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    confirmed_by     VARCHAR(8)   NULL REFERENCES mfg.operator(operator_id),
    confirmed_at     DATETIME2(0) NULL,
    as_planned       BIT          NULL,                  -- NULL until confirmed
    actual_1 FLOAT NULL, actual_2 FLOAT NULL, actual_3 FLOAT NULL,   -- real units (numeric) or -1/+1 (categorical)
    deviation_note   NVARCHAR(200) NULL,
    response         FLOAT        NULL,                  -- manual / simulated; line value is looked up live
    response_source  VARCHAR(10)  NULL,                  -- manual | simulated
    PRIMARY KEY (experiment_id, run_no),
    FOREIGN KEY (experiment_id, run_no) REFERENCES mfg.experiment_run(experiment_id, run_no)
);
GO
-- a unit can only ever be in one experiment
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_experiment_unit_serial')
    CREATE UNIQUE INDEX uq_experiment_unit_serial ON mfg.experiment_unit(serial);
IF COL_LENGTH('mfg.experiment', 'sim_truth') IS NULL
    ALTER TABLE mfg.experiment ADD sim_truth NVARCHAR(MAX) NULL;   -- JSON: hidden effects used by "Simulate results"
GO
