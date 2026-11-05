// Ask for the secrets a Gitea setup stores, without echoing them.
import { stdin, stdout } from "node:process";
import { type AddOptions, SECRETS } from "./options.ts";

/** Ask for each secret without echoing it, or take it from the environment. */
export async function askSecrets(): Promise<AddOptions["secrets"]> {
  if (!stdin.isTTY) {
    throw new Error(`--secrets asks in a terminal; otherwise set ${SECRETS.join(", ")}`);
  }
  const secrets: AddOptions["secrets"] = {};
  for (const name of SECRETS) {
    secrets[name] = process.env[name] || (await askHidden(`${name} (empty to skip): `)).trim();
  }
  return secrets;
}

/** Read one line from the terminal without showing what's typed. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Raw mode hands over each keypress, unechoed
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };

    // Enter ends the line, Ctrl-C cancels, backspace deletes; bracketed-paste markers are dropped
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value.replace(/\[20[01]~/g, ""));
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    stdin.on("data", onData);
  });
}
