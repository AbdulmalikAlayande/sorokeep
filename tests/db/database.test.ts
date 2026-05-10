import type Database from "better-sqlite3";
import { beforeEach } from "vitest";
import { getDatabaseForTesting } from "../../src/db/database";

let db: Database.Database;

beforeEach(() => {
    db = getDatabaseForTesting();
});