import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MCP_MODE, type McpMode } from "../utils/config.js";

/**
 * The tag a tool registration carries to declare that it does not change state.
 * `readOnlyHint` is the MCP specification's own annotation, so tagging this way
 * both drives the permission check below and shows up in `tools/list` for
 * clients that surface it.
 */
export const READ_ONLY_ANNOTATIONS = { readOnlyHint: true } as const;

/** The error text returned when a write-capable tool is called in read-only mode. */
export function readOnlyRejectionMessage(toolName: string): string {
    return (
        `Tool "${toolName}" is not available: the sorokeep MCP server is running in read-only mode. ` +
        `This tool can change state, so it can only be called when the server runs in read-write mode. ` +
        `Set "mcp.mode: read-write" in ~/.sorokeep/config.yaml to enable it.`
    );
}

/**
 * The slice of a `RegisteredTool` this module needs. Declared structurally so
 * the wrapper does not depend on the SDK's generic parameters, which differ
 * between the `.tool()` and `.registerTool()` return types.
 */
interface RegisteredToolLike {
    annotations?: { readOnlyHint?: boolean };
    update: (updates: { callback: (...args: unknown[]) => CallToolResult }) => void;
}

function isReadOnlyTool(registration: RegisteredToolLike): boolean {
    return registration.annotations?.readOnlyHint === true;
}

/**
 * Enforces an MCP permission mode on a server.
 *
 * In `read-write` mode every registered tool is callable. In `read-only` mode a
 * tool is callable only if its registration is tagged {@link READ_ONLY_ANNOTATIONS};
 * anything else is refused before its handler runs, with an error explaining why.
 *
 * Untagged tools are treated as state-changing on purpose. A tool that forgets
 * the tag is then refused in the restrictive mode rather than silently allowed,
 * so the failure mode of a mistake is a visible error and not a write that
 * should not have happened.
 *
 * Both registration methods are wrapped, and the check is installed by replacing
 * the registered callback *after* registration — that reads the annotations the
 * SDK actually resolved instead of re-deriving them from `.tool()`'s overloads.
 *
 * Call this before registering any tool, and before
 * {@link instrumentMcpToolInvocations} so a refused call is not counted as an
 * invocation.
 */
export function applyMcpPermissions<T extends McpServer>(server: T, mode: McpMode = DEFAULT_MCP_MODE): T {
    if (mode === "read-write") return server;

    const guard = (toolName: string, registration: RegisteredToolLike): void => {
        if (isReadOnlyTool(registration)) return;

        registration.update({
            callback: () => ({
                content: [{ type: "text", text: readOnlyRejectionMessage(toolName) }],
                isError: true,
            }),
        });
    };

    // Both methods are overloaded, so they are called through a widened
    // signature: the wrapper only ever forwards arguments untouched.
    type Registrar = (...args: unknown[]) => RegisteredToolLike;
    const originalTool = server.tool.bind(server) as unknown as Registrar;
    const originalRegisterTool = server.registerTool.bind(server) as unknown as Registrar;

    const wrap = (register: Registrar): Registrar => (...args: unknown[]) => {
        const registration = register(...args);
        guard(args[0] as string, registration);
        return registration;
    };

    server.tool = wrap(originalTool) as unknown as T["tool"];
    server.registerTool = wrap(originalRegisterTool) as unknown as T["registerTool"];

    return server;
}
