import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import { serverUrl, defaultPort, WS_URL, reconnectInterval } from "../config/config";
import { FigmaCommand, FigmaResponse, CommandProgressUpdate, PendingRequest, ProgressMessage } from "../types";
import {
  startWebSocketServer,
  stopWebSocketServer,
  getActiveChannels,
  getCurrentChannel as getServerCurrentChannel,
  setCurrentChannel as setServerCurrentChannel,
  isServerRunning,
  getServerStats,
  getChannelClientCount
} from "./websocket-server";

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
let currentChannel: string | null = null;
let autoConnectEnabled: boolean = true;

// Map of pending requests for promise tracking
const pendingRequests = new Map<string, PendingRequest>();

/**
 * Initialize the integrated WebSocket server and client
 */
export function initializeWebSocket(port: number = defaultPort): void {
  // Start the WebSocket server
  const server = startWebSocketServer(port);
  if (server) {
    logger.info("Integrated WebSocket server started");
    // Connect as a client to our own server
    connectToFigma(port);
  }
}

/**
 * Connects to the Figma server via WebSocket.
 * @param port - Optional port for the connection (defaults to defaultPort from config)
 */
export function connectToFigma(port: number = defaultPort) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  // If connection is in progress (CONNECTING state), wait
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    logger.info('Connection to Figma is already in progress');
    return;
  }

  // If there's an existing socket in a closing state, clean it up
  if (ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
    ws.removeAllListeners();
    ws = null;
  }

  const wsUrl = `ws://localhost:${port}`;
  logger.info(`Connecting to WebSocket server at ${wsUrl}...`);

  try {
    ws = new WebSocket(wsUrl);

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        logger.error('Connection timed out');
        ws.terminate();
      }
    }, 10000);

    ws.on('open', () => {
      clearTimeout(connectionTimeout);
      logger.info('Connected to WebSocket server');
      currentChannel = null;

      // Auto-connect to available channel if enabled
      if (autoConnectEnabled) {
        setTimeout(() => tryAutoConnect(), 1000);
      }
    });

    ws.on("message", (data: any) => {
      try {
        const json = JSON.parse(data) as ProgressMessage;

        // Handle progress updates
        if (json.type === 'progress_update') {
          const progressData = json.message.data as CommandProgressUpdate;
          const requestId = json.id || '';

          if (requestId && pendingRequests.has(requestId)) {
            const request = pendingRequests.get(requestId)!;
            request.lastActivity = Date.now();
            clearTimeout(request.timeout);

            request.timeout = setTimeout(() => {
              if (pendingRequests.has(requestId)) {
                logger.error(`Request ${requestId} timed out`);
                pendingRequests.delete(requestId);
                request.reject(new Error('Request to Figma timed out'));
              }
            }, 120000);

            logger.info(`Progress: ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);
          }
          return;
        }

        // Handle regular responses
        const myResponse = json.message;
        logger.debug(`Received message: ${JSON.stringify(myResponse)}`);

        if (
          myResponse.id &&
          pendingRequests.has(myResponse.id) &&
          myResponse.result
        ) {
          const request = pendingRequests.get(myResponse.id)!;
          clearTimeout(request.timeout);

          if (myResponse.error) {
            logger.error(`Error from Figma: ${myResponse.error}`);
            request.reject(new Error(myResponse.error));
          } else {
            if (myResponse.result) {
              request.resolve(myResponse.result);
            }
          }

          pendingRequests.delete(myResponse.id);
        } else {
          logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
        }
      } catch (error) {
        logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    ws.on('error', (error) => {
      logger.error(`Socket error: ${error}`);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(connectionTimeout);
      logger.info(`Disconnected with code ${code}`);
      ws = null;

      // Reject all pending requests
      for (const [id, request] of pendingRequests.entries()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`Connection closed`));
        pendingRequests.delete(id);
      }

      // Attempt to reconnect
      const backoff = Math.min(30000, reconnectInterval * Math.pow(1.5, Math.floor(Math.random() * 5)));
      logger.info(`Attempting to reconnect in ${backoff/1000} seconds...`);
      setTimeout(() => connectToFigma(port), backoff);
    });

  } catch (error) {
    logger.error(`Failed to create WebSocket connection: ${error instanceof Error ? error.message : String(error)}`);
    setTimeout(() => connectToFigma(port), reconnectInterval);
  }
}

/**
 * Try to auto-connect to an available channel
 */
async function tryAutoConnect(): Promise<void> {
  const channels = getActiveChannels();

  if (channels.length === 0) {
    logger.info("No Figma plugins connected yet. Waiting for connection...");
    return;
  }

  if (channels.length === 1 && !currentChannel) {
    logger.info(`Auto-connecting to channel: ${channels[0]}`);
    try {
      await joinChannel(channels[0]);
    } catch (error) {
      logger.error(`Auto-connect failed: ${error}`);
    }
  } else if (channels.length > 1) {
    logger.info(`Multiple channels available: ${channels.join(", ")}. Use join_channel to select one.`);
  }
}

/**
 * Auto-connect to Figma - finds and connects to available channel
 */
export async function autoConnect(): Promise<{ success: boolean; channel?: string; message: string; availableChannels?: string[] }> {
  const channels = getActiveChannels();

  if (channels.length === 0) {
    return {
      success: false,
      message: "No Figma plugins connected. Please run the Figma plugin first."
    };
  }

  if (currentChannel) {
    return {
      success: true,
      channel: currentChannel,
      message: `Already connected to channel: ${currentChannel}`
    };
  }

  if (channels.length === 1) {
    try {
      await joinChannel(channels[0]);
      return {
        success: true,
        channel: channels[0],
        message: `Connected to channel: ${channels[0]}`
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // Multiple channels available
  return {
    success: false,
    message: `Multiple channels available. Please use join_channel with one of: ${channels.join(", ")}`,
    availableChannels: channels
  };
}

/**
 * Disconnect from current channel
 */
export function disconnect(): { success: boolean; message: string } {
  if (!currentChannel) {
    return {
      success: false,
      message: "Not connected to any channel"
    };
  }

  const previousChannel = currentChannel;
  currentChannel = null;
  setServerCurrentChannel(null);

  return {
    success: true,
    message: `Disconnected from channel: ${previousChannel}`
  };
}

/**
 * Get connection status
 */
export function getConnectionStatus(): {
  serverRunning: boolean;
  connected: boolean;
  currentChannel: string | null;
  availableChannels: string[];
  stats: any;
} {
  return {
    serverRunning: isServerRunning(),
    connected: currentChannel !== null,
    currentChannel,
    availableChannels: getActiveChannels(),
    stats: getServerStats()
  };
}

/**
 * Join a specific channel in Figma.
 * @param channelName - Name of the channel to join
 * @returns Promise that resolves when successfully joined the channel
 */
export async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to WebSocket server");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    setServerCurrentChannel(channelName);
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Get the current channel the connection is joined to.
 * @returns The current channel name or null if not connected to any channel
 */
export function getCurrentChannel(): string | null {
  return currentChannel;
}

/**
 * Enable or disable auto-connect feature
 */
export function setAutoConnect(enabled: boolean): void {
  autoConnectEnabled = enabled;
  logger.info(`Auto-connect ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Send a command to Figma via WebSocket.
 * @param command - The command to send
 * @param params - Additional parameters for the command
 * @param timeoutMs - Timeout in milliseconds before failing
 * @returns A promise that resolves with the Figma response
 */
export function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 60000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to WebSocket server. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands. Use auto_connect or join_channel."));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id,
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Store the promise callbacks
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}
