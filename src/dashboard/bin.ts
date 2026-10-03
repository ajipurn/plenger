#!/usr/bin/env node
import { main } from "../cli.ts";

process.exitCode = await main(["serve", ...process.argv.slice(2)]);
