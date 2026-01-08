import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  autoConnect,
  disconnect,
  getConnectionStatus,
  joinChannel,
  getCurrentChannel
} from "../utils/websocket";

/**
 * Register connection management tools to the MCP server
 * These tools handle Figma connection without requiring manual channel management
 * @param server - The MCP server instance
 */
export function registerConnectionTools(server: McpServer): void {

  // Auto Connect Tool - automatically finds and connects to Figma
  server.tool(
    "auto_connect",
    "Connect to Figma automatically. No parameters required. Call this tool first before using any other Figma tools. It will find and connect to the running Figma plugin.",
    {},
    async () => {
      try {
        const result = await autoConnect();

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: result.message,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: result.availableChannels
                  ? `${result.message}\nAvailable channels: ${result.availableChannels.join(", ")}`
                  : result.message,
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error during auto-connect: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // Disconnect Tool - disconnect from current channel
  server.tool(
    "disconnect_figma",
    "Disconnect from the current Figma channel",
    {},
    async () => {
      try {
        const result = disconnect();
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error disconnecting: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // Get Connection Status Tool
  server.tool(
    "get_connection_status",
    "Get the current Figma connection status, available channels, and server statistics",
    {},
    async () => {
      try {
        const status = getConnectionStatus();

        const statusText = [
          `Server Running: ${status.serverRunning ? "Yes" : "No"}`,
          `Connected: ${status.connected ? "Yes" : "No"}`,
          `Current Channel: ${status.currentChannel || "None"}`,
          `Available Channels: ${status.availableChannels.length > 0 ? status.availableChannels.join(", ") : "None"}`,
          `Active Connections: ${status.stats.activeConnections}`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: statusText,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  // Manual Join Channel Tool (for cases with multiple channels)
  server.tool(
    "join_channel",
    "Manually join a specific Figma channel by ID. Only use this when auto_connect reports multiple channels available. Requires channel ID parameter.",
    {
      channel: z.string().describe("The channel ID to join (shown in Figma plugin or from get_connection_status)"),
    },
    async ({ channel }) => {
      try {
        const currentCh = getCurrentChannel();
        if (currentCh === channel) {
          return {
            content: [
              {
                type: "text",
                text: `Already connected to channel: ${channel}`,
              },
            ],
          };
        }

        await joinChannel(channel);
        return {
          content: [
            {
              type: "text",
              text: `Successfully joined channel: ${channel}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error joining channel: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}
