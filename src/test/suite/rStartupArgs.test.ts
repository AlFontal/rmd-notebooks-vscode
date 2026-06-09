import { strict as assert } from "node:assert";
import packageJson from "../../../package.json";
import {
  DEFAULT_INLINE_R_ARGS,
  DEFAULT_TERMINAL_R_ARGS,
  getInlineRArgs,
  getTerminalRArgs
} from "../../../src/execution/rStartupArgs";

describe("rStartupArgs", () => {
  it("defaults inline R args to the current inline behavior", () => {
    const configuration = testConfiguration({});

    assert.deepEqual(getInlineRArgs(configuration), ["--slave"]);
  });

  it("defaults terminal R args to the current terminal behavior", () => {
    const configuration = testConfiguration({});

    assert.deepEqual(getTerminalRArgs(configuration), ["--vanilla"]);
  });

  it("uses configured inline R args instead of the default", () => {
    const configuration = testConfiguration({
      "r.args": ["--slave"]
    });

    assert.deepEqual(getInlineRArgs(configuration), ["--slave"]);
  });

  it("uses configured terminal R args instead of the default", () => {
    const configuration = testConfiguration({
      "r.terminalArgs": ["--quiet"]
    });

    assert.deepEqual(getTerminalRArgs(configuration), ["--quiet"]);
  });

  it("respects an empty inline R args array", () => {
    const configuration = testConfiguration({
      "r.args": []
    });

    assert.deepEqual(getInlineRArgs(configuration), []);
  });

  it("respects an empty terminal R args array", () => {
    const configuration = testConfiguration({
      "r.terminalArgs": []
    });

    assert.deepEqual(getTerminalRArgs(configuration), []);
  });

  it("returns a copy of default args", () => {
    const configuration = testConfiguration({});

    assert.notEqual(getInlineRArgs(configuration), DEFAULT_INLINE_R_ARGS);
    assert.notEqual(getTerminalRArgs(configuration), DEFAULT_TERMINAL_R_ARGS);
  });

  it("contributes the inline and terminal settings with runtime defaults", () => {
    const properties = packageJson.contributes.configuration.properties;

    assert.deepEqual(properties["rmdNotebooks.r.args"].default, [...DEFAULT_INLINE_R_ARGS]);
    assert.deepEqual(properties["rmdNotebooks.r.terminalArgs"].default, [...DEFAULT_TERMINAL_R_ARGS]);
    assert.equal(properties["rmdNotebooks.r.sourceVscodeRSessionWatcher"].default, true);
    assert.equal(properties["rmdNotebooks.output.dataFrameMaxRows"].type, "integer");
    assert.equal(properties["rmdNotebooks.output.dataFrameMaxRows"].default, 50);
    assert.equal(properties["rmdNotebooks.output.dataFrameMaxColumns"].type, "integer");
    assert.equal(properties["rmdNotebooks.output.dataFrameMaxColumns"].default, 50);
  });
});

function testConfiguration(values: Record<string, string[]>) {
  return {
    get<T>(section: string, defaultValue: T): T {
      return (Object.prototype.hasOwnProperty.call(values, section) ? values[section] : defaultValue) as T;
    }
  };
}
