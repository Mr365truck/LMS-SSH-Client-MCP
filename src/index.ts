import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Client, ConnectConfig, SFTPWrapper } from "ssh2";
import os from "os";
import path from "path";
import fs from "fs/promises";

// Safe logging to stderr (so stdio transport is not corrupted)
function log(message: string, ...args: any[]) {
  console.error(`[SSH-MCP] ${message}`, ...args);
}

// Global active SSH sessions map
interface SshSession {
  id: string;
  client: Client;
  host: string;
  port: number;
  username: string;
  connectedAt: Date;
}

const sessions = new Map<string, SshSession>();

// Generate user-friendly random connection IDs
function generateSessionId(): string {
  return "ssh_" + Math.random().toString(36).substring(2, 9);
}

// Find default local private keys to support quick passwordless connecting
async function findDefaultPrivateKey(): Promise<string | null> {
  const home = os.homedir();
  const possiblePaths = [
    path.join(home, ".ssh", "id_ed25519"),
    path.join(home, ".ssh", "id_rsa"),
    path.join(home, ".ssh", "id_ecdsa"),
    path.join(home, ".ssh", "id_dsa"),
  ];

  for (const keyPath of possiblePaths) {
    try {
      const content = await fs.readFile(keyPath, "utf8");
      log(`Found default private key file at ${keyPath}`);
      return content;
    } catch (e) {
      // Key file doesn't exist or is not readable, try next
    }
  }
  return null;
}

// Connect SSH helper
function connectSsh(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let resolved = false;

    conn.on("ready", () => {
      resolved = true;
      resolve(conn);
    });

    conn.on("error", (err) => {
      log(`Connection error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    conn.connect(config);
  });
}

// Execute command helper
const MAX_OUTPUT_LENGTH = 1024 * 1024; // 1MB output cap
function executeCommand(
  conn: Client,
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number; signal?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Command execution timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }

      stream.on("close", (code: number, signal: string) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve({ stdout, stderr, exitCode: code, signal });
        }
      });

      stream.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_LENGTH) {
          stdout += data.toString("utf8");
          if (stdout.length >= MAX_OUTPUT_LENGTH) {
            stdout += "\n[OUTPUT TRUNCATED BY MCP SERVER: EXCESSIVE SIZE]";
          }
        }
      });

      stream.stderr.on("data", (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_LENGTH) {
          stderr += data.toString("utf8");
          if (stderr.length >= MAX_OUTPUT_LENGTH) {
            stderr += "\n[STDERR TRUNCATED BY MCP SERVER: EXCESSIVE SIZE]";
          }
        }
      });
    });
  });
}

// SFTP promise wrappers
function getSftp(session: SshSession): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err);
      resolve(list);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) return reject(err);
      resolve(stats);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, buffer) => {
      if (err) return reject(err);
      resolve(buffer);
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sftpDeleteFile(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sftpRmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function sftpRename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Mode parsing helper for readable lists
function parseMode(mode: number): { type: string; permissions: string } {
  let type = "other";
  if ((mode & 0o170000) === 0o040000) {
    type = "directory";
  } else if ((mode & 0o170000) === 0o120000) {
    type = "symlink";
  } else if ((mode & 0o170000) === 0o100000) {
    type = "file";
  }

  const r = (m: number) => (m & 4 ? "r" : "-");
  const w = (m: number) => (m & 2 ? "w" : "-");
  const x = (m: number) => (m & 1 ? "x" : "-");

  const u = r(mode >> 6) + w(mode >> 6) + x(mode >> 6);
  const g = r(mode >> 3) + w(mode >> 3) + x(mode >> 3);
  const o = r(mode) + w(mode) + x(mode);

  const prefix = type === "directory" ? "d" : type === "symlink" ? "l" : "-";
  return { type, permissions: prefix + u + g + o };
}

// Zod schemas for input validation
const SshConnectSchema = z.object({
  host: z.string(),
  port: z.number().default(22),
  username: z.string(),
  password: z.string().optional(),
  pw: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  readyTimeout: z.number().default(20000),
});

const SshExecuteCommandSchema = z.object({
  connectionId: z.string(),
  command: z.string(),
  timeoutMs: z.number().default(30000),
});

const SshCloseConnectionSchema = z.object({
  connectionId: z.string(),
});

const SshSftpListDirSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
});

const SshSftpReadFileSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
  encoding: z.string().default("utf8"),
});

const SshSftpWriteFileSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
  content: z.string(),
  encoding: z.string().default("utf8"),
});

const SshSftpDeleteFileSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
});

const SshSftpMkdirSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
});

const SshSftpRmdirSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
});

const SshSftpRenameSchema = z.object({
  connectionId: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
});

// Initialize the MCP Server
const server = new Server(
  {
    name: "lms-ssh-client-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ssh_connect",
        description: "Connect to a remote SSH server. Returns a session ID to be used for subsequent commands and files. If neither password nor privateKey are specified, this tool will attempt to use default keys in your ~/.ssh directory. If a file path is provided in privateKey, it will be loaded from disk.",
        inputSchema: {
          type: "object",
          properties: {
            host: { type: "string", description: "Remote host name or IP address" },
            port: { type: "number", description: "Port number (default: 22)" },
            username: { type: "string", description: "Username for connection" },
            password: { type: "string", description: "Password (if using password authentication)" },
            pw: { type: "string", description: "Alias for password (helpful fallback for small LLMs)" },
            privateKey: { type: "string", description: "Raw private key content OR a local path (e.g. '~/.ssh/id_rsa') to the key" },
            passphrase: { type: "string", description: "Passphrase to decrypt the private key (if encrypted)" },
            readyTimeout: { type: "number", description: "Connection timeout in milliseconds (default: 20000)" },
          },
          required: ["host", "username"],
        },
      },
      {
        name: "ssh_execute_command",
        description: "Execute a command on the remote host via SSH. Note: Shell environment state like current directory (cd) is NOT preserved between distinct tool calls. To run multiple commands in the same path, chain them (e.g. 'cd /var/www && ls -la').",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            command: { type: "string", description: "The command line string to run on the remote shell" },
            timeoutMs: { type: "number", description: "Execution timeout in milliseconds (default: 30000)" },
          },
          required: ["connectionId", "command"],
        },
      },
      {
        name: "ssh_close_connection",
        description: "Close an active SSH connection.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID of the connection to close" },
          },
          required: ["connectionId"],
        },
      },
      {
        name: "ssh_list_connections",
        description: "List all active SSH connection IDs and details.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "ssh_sftp_list_dir",
        description: "List files and directories on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote path to list (e.g., '.', '/var/log')" },
          },
          required: ["connectionId", "path"],
        },
      },
      {
        name: "ssh_sftp_read_file",
        description: "Read the contents of a file on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote path of the file to read" },
            encoding: { type: "string", description: "Encoding to use (e.g. 'utf8', 'base64' for binary files). Default is 'utf8'." },
          },
          required: ["connectionId", "path"],
        },
      },
      {
        name: "ssh_sftp_write_file",
        description: "Write content to a file on the remote server using SFTP. Creates the file if it does not exist.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote path of the file to write" },
            content: { type: "string", description: "Content to write" },
            encoding: { type: "string", description: "Encoding of the content (e.g. 'utf8', 'base64' for binary data). Default is 'utf8'." },
          },
          required: ["connectionId", "path", "content"],
        },
      },
      {
        name: "ssh_sftp_delete_file",
        description: "Delete a file on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote file path to delete" },
          },
          required: ["connectionId", "path"],
        },
      },
      {
        name: "ssh_sftp_mkdir",
        description: "Create a directory on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote directory path to create" },
          },
          required: ["connectionId", "path"],
        },
      },
      {
        name: "ssh_sftp_rmdir",
        description: "Remove an empty directory on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            path: { type: "string", description: "Remote directory path to remove" },
          },
          required: ["connectionId", "path"],
        },
      },
      {
        name: "ssh_sftp_rename",
        description: "Rename or move a file or directory on the remote server using SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            connectionId: { type: "string", description: "The session ID returned by ssh_connect" },
            oldPath: { type: "string", description: "Current remote path of the file or directory" },
            newPath: { type: "string", description: "New remote path for the file or directory" },
          },
          required: ["connectionId", "oldPath", "newPath"],
        },
      },
    ],
  };
});

// Helper to retrieve session and validate existence
function getSession(id: string): SshSession {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Active connection not found for session ID "${id}". Make sure you are connected first using ssh_connect.`);
  }
  return session;
}

// Call Tool Request Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "ssh_connect": {
        const params = SshConnectSchema.parse(args);
        const { host, port, username, privateKey, passphrase, readyTimeout } = params;
        const password = params.password || params.pw;

        log(`Connecting to ${username}@${host}:${port}...`);

        const connConfig: ConnectConfig = {
          host,
          port,
          username,
          readyTimeout,
        };

        if (password) {
          connConfig.password = password;
        } else {
          let resolvedKey = privateKey;
          if (!resolvedKey) {
            log(`No authentication keys or password specified, checking default SSH keys...`);
            resolvedKey = await findDefaultPrivateKey() || undefined;
          } else if (!resolvedKey.startsWith("-----BEGIN")) {
            // Assume it's a local file path
            let resolvedPath = resolvedKey;
            if (resolvedPath.startsWith("~")) {
              resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
            } else {
              resolvedPath = path.resolve(resolvedPath);
            }
            log(`Reading private key file from: ${resolvedPath}`);
            resolvedKey = await fs.readFile(resolvedPath, "utf8");
          }

          if (resolvedKey) {
            connConfig.privateKey = resolvedKey;
            if (passphrase) {
              connConfig.passphrase = passphrase;
            }
          } else {
            throw new Error(
              "No authentication credentials provided. Must specify 'password', 'privateKey' file path/content, or have a default key in ~/.ssh (e.g. id_rsa, id_ed25519)."
            );
          }
        }

        let client;
        try {
          client = await connectSsh(connConfig);
        } catch (err: any) {
          let errMsg = err.message || err;
          if (errMsg.includes("All configured authentication methods failed") && !password) {
            errMsg += ". Note: No password was supplied to the ssh_connect tool. If this remote server requires password authentication, please pass the user's password using the 'password' parameter.";
          }
          throw new Error(errMsg);
        }
        const connectionId = generateSessionId();

        client.on("close", () => {
          log(`SSH connection closed for session: ${connectionId}`);
          sessions.delete(connectionId);
        });

        client.on("error", (err) => {
          log(`SSH connection error for session ${connectionId}: ${err.message}`);
          sessions.delete(connectionId);
        });

        sessions.set(connectionId, {
          id: connectionId,
          client,
          host,
          port,
          username,
          connectedAt: new Date(),
        });

        log(`Successfully connected. Session ID: ${connectionId}`);
        return {
          content: [
            {
              type: "text",
              text: `Successfully established SSH connection to ${username}@${host}:${port}.\nSession ID: ${connectionId}\nYou can now execute commands and run SFTP actions using this connectionId.`,
            },
          ],
        };
      }

      case "ssh_execute_command": {
        const { connectionId, command, timeoutMs } = SshExecuteCommandSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: Executing command: "${command}"`);
        const result = await executeCommand(session.client, command, timeoutMs);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                signal: result.signal,
              }, null, 2),
            },
          ],
        };
      }

      case "ssh_close_connection": {
        const { connectionId } = SshCloseConnectionSchema.parse(args);
        const session = getSession(connectionId);

        log(`Closing session ${connectionId}...`);
        session.client.end();
        sessions.delete(connectionId);

        return {
          content: [
            {
              type: "text",
              text: `SSH Connection for session "${connectionId}" was closed successfully.`,
            },
          ],
        };
      }

      case "ssh_list_connections": {
        const connectionsList = Array.from(sessions.values()).map((s) => ({
          connectionId: s.id,
          host: s.host,
          port: s.port,
          username: s.username,
          connectedAt: s.connectedAt.toISOString(),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ connections: connectionsList }, null, 2),
            },
          ],
        };
      }

      case "ssh_sftp_list_dir": {
        const { connectionId, path: remotePath } = SshSftpListDirSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Listing directory: ${remotePath}`);
        const sftp = await getSftp(session);
        try {
          const list = await sftpReaddir(sftp, remotePath);
          const formattedFiles = list.map((entry) => {
            const parsed = parseMode(entry.attrs.mode);
            return {
              name: entry.filename,
              type: parsed.type,
              size: entry.attrs.size,
              mtime: new Date(entry.attrs.mtime * 1000).toISOString(),
              permissions: parsed.permissions,
              uid: entry.attrs.uid,
              gid: entry.attrs.gid,
            };
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ files: formattedFiles }, null, 2),
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_read_file": {
        const { connectionId, path: remotePath, encoding } = SshSftpReadFileSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Reading file: ${remotePath}`);
        const sftp = await getSftp(session);
        try {
          const stats = await sftpStat(sftp, remotePath);
          const parsed = parseMode(stats.mode);

          if (parsed.type === "directory") {
            throw new Error(`Path "${remotePath}" is a directory, not a file.`);
          }

          const MAX_READ_SIZE = 2 * 1024 * 1024; // 2MB
          if (stats.size > MAX_READ_SIZE) {
            throw new Error(
              `File is too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Maximum readable size is ${
                MAX_READ_SIZE / 1024 / 1024
              }MB. Use ssh_execute_command to inspect chunked or tail output.`
            );
          }

          const buffer = await sftpReadFile(sftp, remotePath);
          const textContent = buffer.toString(encoding as BufferEncoding);

          return {
            content: [
              {
                type: "text",
                text: textContent,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_write_file": {
        const { connectionId, path: remotePath, content, encoding } = SshSftpWriteFileSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Writing file: ${remotePath} (${encoding})`);
        const sftp = await getSftp(session);
        try {
          const buffer = Buffer.from(content, encoding as BufferEncoding);
          await sftpWriteFile(sftp, remotePath, buffer);

          return {
            content: [
              {
                type: "text",
                text: `Successfully wrote ${buffer.length} bytes to remote file: ${remotePath}`,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_delete_file": {
        const { connectionId, path: remotePath } = SshSftpDeleteFileSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Deleting file: ${remotePath}`);
        const sftp = await getSftp(session);
        try {
          await sftpDeleteFile(sftp, remotePath);
          return {
            content: [
              {
                type: "text",
                text: `Successfully deleted remote file: ${remotePath}`,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_mkdir": {
        const { connectionId, path: remotePath } = SshSftpMkdirSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Creating directory: ${remotePath}`);
        const sftp = await getSftp(session);
        try {
          await sftpMkdir(sftp, remotePath);
          return {
            content: [
              {
                type: "text",
                text: `Successfully created directory: ${remotePath}`,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_rmdir": {
        const { connectionId, path: remotePath } = SshSftpRmdirSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Removing directory: ${remotePath}`);
        const sftp = await getSftp(session);
        try {
          await sftpRmdir(sftp, remotePath);
          return {
            content: [
              {
                type: "text",
                text: `Successfully removed directory: ${remotePath}`,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      case "ssh_sftp_rename": {
        const { connectionId, oldPath, newPath } = SshSftpRenameSchema.parse(args);
        const session = getSession(connectionId);

        log(`Session ${connectionId}: SFTP Renaming ${oldPath} to ${newPath}`);
        const sftp = await getSftp(session);
        try {
          await sftpRename(sftp, oldPath, newPath);
          return {
            content: [
              {
                type: "text",
                text: `Successfully renamed/moved ${oldPath} to ${newPath}`,
              },
            ],
          };
        } finally {
          sftp.end();
        }
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (err: any) {
    log(`Error calling tool "${name}": ${err.message || err}`);
    if (err instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Validation Error: ${err.issues
              .map((e) => `${e.path.join(".")}: ${e.message}`)
              .join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `SSH MCP Error: ${err.message || err}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server using stdio transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("SSH MCP Server running on stdio transport");
}

// Handle termination signals to cleanly disconnect all sessions
function cleanup() {
  log("Shutting down SSH MCP Server, closing connections...");
  for (const [id, session] of sessions) {
    try {
      session.client.end();
      log(`Closed session: ${id}`);
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
  sessions.clear();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

run().catch((error) => {
  log(`Fatal error running server: ${error.message || error}`);
  process.exit(1);
});
