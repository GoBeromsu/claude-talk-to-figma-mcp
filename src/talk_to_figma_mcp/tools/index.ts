import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocumentTools } from "./document-tools";
import { registerCreationTools } from "./creation-tools";
import { registerModificationTools } from "./modification-tools";
import { registerTextTools } from "./text-tools";
import { registerComponentTools } from "./component-tools";
import { registerConnectionTools } from "./connection-tools";

/**
 * Register all Figma tools to the MCP server
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  // Register connection tools first (for auto-connect capability)
  registerConnectionTools(server);

  // Register all tool categories
  registerDocumentTools(server);
  registerCreationTools(server);
  registerModificationTools(server);
  registerTextTools(server);
  registerComponentTools(server);
}

// Export all tool registration functions for individual usage if needed
export {
  registerConnectionTools,
  registerDocumentTools,
  registerCreationTools,
  registerModificationTools,
  registerTextTools,
  registerComponentTools
};