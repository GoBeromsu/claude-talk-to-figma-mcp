#!/usr/bin/env node

/**
 * Main entry point for the Figma MCP Server
 * This file initializes the server, connects to Figma,
 * and registers all tools and prompts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Import configuration
import { SERVER_CONFIG } from "./config/config";

// Import utilities
import { logger } from "./utils/logger";
import { initializeWebSocket } from "./utils/websocket";

// Import tools registration function from tools/index.ts
import { registerTools } from "./tools";

// Import prompts registration function from prompts/index.ts
import { registerPrompts } from "./prompts";

/**
 * Initialize and start the MCP server
 */
async function main() {
  try {
    // Create MCP server instance with configuration
    const server = new McpServer(SERVER_CONFIG);
    
    // Register all tools with the server
    registerTools(server);
    
    // Register all prompts with the server
    registerPrompts(server);
    
    // Initialize integrated WebSocket server (no separate bun socket needed!)
    try {
      initializeWebSocket();
      logger.info('WebSocket server started on port 3055');
    } catch (error) {
      logger.warn(`Could not initialize WebSocket server: ${error instanceof Error ? error.message : String(error)}`);
      logger.warn('Figma connection may not work properly');
    }

    // Start the MCP server with stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('FigmaMCP server running on stdio');
  } catch (error) {
    logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

