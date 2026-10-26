import { describe, expect, test } from "bun:test";
import {
  parseReflectCommandArgs,
  REFLECT_COMMAND_USAGE,
} from "./reflect-command";

describe.each(["dream", "reflect", "reflection"])("/%s arguments", (alias) => {
  test("accepts the instruction parameter in its supported spellings", () => {
    expect(parseReflectCommandArgs(`/${alias}`)).toEqual({});
    expect(
      parseReflectCommandArgs(`/${alias} --instruction remember this`),
    ).toEqual({ instruction: "remember this" });
    expect(
      parseReflectCommandArgs(`/${alias} --instruction="remember this"`),
    ).toEqual({ instruction: "remember this" });
    expect(parseReflectCommandArgs(`/${alias} -i remember this`)).toEqual({
      instruction: "remember this",
    });
  });

  test("rejects the retired cross-conversation parameters with the new usage", () => {
    for (const flag of ["--recent", "--conversation", "--auto"]) {
      expect(() => parseReflectCommandArgs(`/${alias} ${flag} 2`)).toThrow(
        /no longer supported/,
      );
      expect(() => parseReflectCommandArgs(`/${alias} ${flag} 2`)).toThrow(
        REFLECT_COMMAND_USAGE,
      );
    }
  });

  test("rejects malformed arguments", () => {
    for (const args of ["--instruction", "transcript.txt", "--unknown"]) {
      expect(() => parseReflectCommandArgs(`/${alias} ${args}`)).toThrow(
        REFLECT_COMMAND_USAGE,
      );
    }
  });
});
