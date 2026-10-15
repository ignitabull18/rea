import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type {
  ObserveWebApiInput,
  WebApiBody,
} from "../../domain/webApiCapture.js";
import { redactExplicitText } from "../../domain/explicitSensitiveValues.js";

/** Own decoded-byte budgets, textual presentation and caller-declared literal redaction. */
export class CdpApiBodies {
  retainedBytes = 0;
  constructor(readonly input: ObserveWebApiInput) {}
  retain(content: string, base64: boolean): WebApiBody {
    const size = base64
      ? Math.floor(content.length / 4) * 3 -
        (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0)
      : Buffer.byteLength(content);
    if (size > this.input.max_body_bytes)
      return { state: "unavailable", reason: "body_size_limit" };
    if (size + this.retainedBytes > this.input.max_total_body_bytes)
      return { state: "unavailable", reason: "total_body_limit" };
    const bytes = Buffer.from(content, base64 ? "base64" : "utf8");
    if (base64 && bytes.toString("base64") !== content)
      throw new Error("Malformed CDP body base64");
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      /* Binary bodies retain base64 rather than inventing text. */
    }
    if (text === undefined && this.input.sensitive_values.length > 0)
      return { state: "unavailable", reason: "binary_redaction_unavailable" };
    const safe =
      text === undefined
        ? undefined
        : redactExplicitText(text, this.input.sensitive_values);
    const retained = safe === undefined ? bytes : Buffer.from(safe, "utf8");
    if (retained.length > this.input.max_body_bytes)
      return { state: "unavailable", reason: "body_size_limit" };
    if (retained.length + this.retainedBytes > this.input.max_total_body_bytes)
      return { state: "unavailable", reason: "total_body_limit" };
    this.retainedBytes += retained.length;
    return {
      state: "captured",
      encoding: safe === undefined ? "base64" : "utf8",
      content: safe ?? retained.toString("base64"),
      bytes: retained.length,
      sha256: createHash("sha256").update(retained).digest("hex"),
      redacted: safe !== undefined && safe !== text,
    };
  }
}
