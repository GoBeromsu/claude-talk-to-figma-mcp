import { Server, ServerWebSocket } from "bun";
import { logger } from "./logger";

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Track connection state
let wsServer: Server | null = null;
let currentChannel: string | null = null;

// Pending requests for command responses
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason?: any) => void;
  timeout: NodeJS.Timeout;
  lastActivity: number;
}>();

// Server statistics
const stats = {
  totalConnections: 0,
  activeConnections: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0
};

/**
 * Start the WebSocket server
 */
export function startWebSocketServer(port: number = 3055): Server | null {
  if (wsServer) {
    logger.info("WebSocket server already running");
    return wsServer;
  }

  try {
    wsServer = Bun.serve({
      port,
      fetch(req: Request, server: Server) {
        const url = new URL(req.url);

        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        }

        // Handle status endpoint
        if (url.pathname === "/status") {
          return new Response(JSON.stringify({
            status: "running",
            uptime: process.uptime(),
            channels: getActiveChannels(),
            currentChannel,
            stats
          }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        // Handle channels endpoint
        if (url.pathname === "/channels") {
          return new Response(JSON.stringify({
            channels: getActiveChannels(),
            currentChannel
          }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        // Handle WebSocket upgrade
        try {
          const success = server.upgrade(req, {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          });

          if (success) {
            return;
          }
        } catch (error) {
          logger.error("Failed to upgrade WebSocket connection:", error);
          stats.errors++;
          return new Response("Failed to upgrade to WebSocket", { status: 500 });
        }

        return new Response("Figma MCP WebSocket server running.", {
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
      websocket: {
        open(ws: ServerWebSocket<any>) {
          stats.totalConnections++;
          stats.activeConnections++;

          const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          ws.data = { clientId };

          logger.info(`New client connected: ${clientId}`);

          try {
            ws.send(JSON.stringify({
              type: "system",
              message: "Connected to Figma MCP server",
            }));
          } catch (error) {
            logger.error(`Failed to send welcome message:`, error);
            stats.errors++;
          }
        },

        message(ws: ServerWebSocket<any>, message: string | Buffer) {
          try {
            stats.messagesReceived++;
            const clientId = ws.data?.clientId || "unknown";
            const data = JSON.parse(message as string);

            // Handle join channel
            if (data.type === "join") {
              const channelName = data.channel;
              if (!channelName) {
                ws.send(JSON.stringify({ type: "error", message: "Channel name is required" }));
                return;
              }

              if (!channels.has(channelName)) {
                channels.set(channelName, new Set());
                logger.info(`Created new channel: ${channelName}`);
              }

              channels.get(channelName)!.add(ws);
              logger.info(`Client ${clientId} joined channel: ${channelName}`);

              // Send join confirmation
              ws.send(JSON.stringify({
                type: "system",
                message: { id: data.id, result: `Connected to channel: ${channelName}` },
                channel: channelName
              }));
              stats.messagesSent++;

              // Notify other clients
              broadcastToChannel(channelName, {
                type: "system",
                message: "A new client has joined the channel",
                channel: channelName
              }, ws);

              return;
            }

            // Handle regular messages
            if (data.type === "message") {
              const channelName = data.channel;
              if (!channelName) {
                ws.send(JSON.stringify({ type: "error", message: "Channel name is required" }));
                return;
              }

              const channelClients = channels.get(channelName);
              if (!channelClients?.has(ws)) {
                ws.send(JSON.stringify({ type: "error", message: "You must join the channel first" }));
                return;
              }

              // Broadcast to all clients in channel
              broadcastToChannel(channelName, {
                type: "broadcast",
                message: data.message,
                channel: channelName
              });
            }

            // Handle progress updates
            if (data.type === "progress_update") {
              const channelName = data.channel;
              const channelClients = channels.get(channelName);
              if (channelClients) {
                broadcastToChannel(channelName, data);
              }
            }

          } catch (err) {
            stats.errors++;
            logger.error("Error handling message:", err);
            ws.send(JSON.stringify({
              type: "error",
              message: "Error processing message: " + (err instanceof Error ? err.message : String(err))
            }));
          }
        },

        close(ws: ServerWebSocket<any>, code: number, reason: string) {
          const clientId = ws.data?.clientId || "unknown";
          logger.info(`Client disconnected: ${clientId} (code: ${code})`);

          // Remove from all channels
          channels.forEach((clients, channelName) => {
            if (clients.delete(ws)) {
              logger.debug(`Removed ${clientId} from channel ${channelName}`);
              // Clean up empty channels
              if (clients.size === 0) {
                channels.delete(channelName);
                logger.info(`Removed empty channel: ${channelName}`);
              }
            }
          });

          stats.activeConnections--;
        },

        drain(ws: ServerWebSocket<any>) {
          logger.debug(`WebSocket backpressure relieved`);
        }
      }
    });

    logger.info(`WebSocket server started on port ${port}`);
    return wsServer;

  } catch (error) {
    logger.error(`Failed to start WebSocket server: ${error}`);
    return null;
  }
}

/**
 * Stop the WebSocket server
 */
export function stopWebSocketServer(): void {
  if (wsServer) {
    wsServer.stop();
    wsServer = null;
    channels.clear();
    currentChannel = null;
    logger.info("WebSocket server stopped");
  }
}

/**
 * Get list of active channels
 */
export function getActiveChannels(): string[] {
  return Array.from(channels.keys());
}

/**
 * Get number of clients in a channel
 */
export function getChannelClientCount(channelName: string): number {
  return channels.get(channelName)?.size || 0;
}

/**
 * Get current connected channel
 */
export function getCurrentChannel(): string | null {
  return currentChannel;
}

/**
 * Set current channel
 */
export function setCurrentChannel(channel: string | null): void {
  currentChannel = channel;
}

/**
 * Check if server is running
 */
export function isServerRunning(): boolean {
  return wsServer !== null;
}

/**
 * Broadcast message to all clients in a channel
 */
function broadcastToChannel(
  channelName: string,
  message: any,
  excludeClient?: ServerWebSocket<any>
): void {
  const clients = channels.get(channelName);
  if (!clients) return;

  const messageStr = JSON.stringify(message);
  clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
        stats.messagesSent++;
      } catch (error) {
        logger.error("Error broadcasting message:", error);
        stats.errors++;
      }
    }
  });
}

/**
 * Get server statistics
 */
export function getServerStats() {
  return {
    ...stats,
    channelCount: channels.size,
    isRunning: wsServer !== null
  };
}
