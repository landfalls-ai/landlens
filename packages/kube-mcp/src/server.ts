// The built-in MCP server, landlens-kube: the agent's read-only cluster tools and their MCP App views, for one agent
// session's cluster. It isn't on the network itself: the MCP gateway (@landlens/mcp-gateway) runs one per session
// in memory and is what Claude Code talks to, so every call is logged and checked there (docs/mcp.md).
import { BUILTIN_MCP_SERVER } from "@landlens/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentCluster } from "./cluster.js";
import { registerTools } from "./tools.js";

export const MCP_SERVER_NAME = BUILTIN_MCP_SERVER;
export const MCP_SERVER_VERSION = "0.2.0";

/** A landlens-kube server bound to one session's cluster (its own front-door token, namespaces and metrics). */
export function kubeMcpServer(cluster: AgentCluster): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: "Landlens cluster tools", version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerTools(server, cluster);
  return server;
}
