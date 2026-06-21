# Model Context Protocol (MCP) SSH Client Server

An MCP server designed for **LM Studio**, **Claude Desktop**, and other MCP-enabled LLM hosts. This server enables LLMs to securely SSH into remote servers, execute commands, list directories, and manage files (read, write, delete, create directories, rename files) over SFTP.

## Features

- **Persisted SSH Connections**: Establish SSH sessions and maintain them in-memory, allowing consecutive tool calls on the same host without repeating credentials.
- **Remote Command Execution**: Execute shell commands on the remote machine (`ssh_execute_command`).
- **Full SFTP File Manager**:
  - List files and directories with formatted unix permissions, sizes, and timestamps (`ssh_sftp_list_dir`).
  - Read remote files up to 2MB securely (`ssh_sftp_read_file`).
  - Create, write, or update files (`ssh_sftp_write_file`).
  - Delete files (`ssh_sftp_delete_file`).
  - Create and delete directories (`ssh_sftp_mkdir` / `ssh_sftp_rmdir`).
  - Rename or move remote items (`ssh_sftp_rename`).
- **Flexible Authentication**:
  - Authenticate using Username & Password.
  - Authenticate using private keys (either pass the raw key string or a local file path like `~/.ssh/id_rsa`).
  - **Zero-Config Fallback**: If no credentials are specified, the server automatically looks for default keys in your local `~/.ssh/` directory (e.g. `id_ed25519`, `id_rsa`, `id_ecdsa`, etc.) to authenticate passwordlessly.
- **Graceful Shutdown**: Automatically closes all active SSH connections when the LLM client stops the MCP server.

---

## Installation & Setup

1. **Clone and Install Dependencies**:
   Navigate to the directory and run:
   ```bash
   npm install
   ```

2. **Build the Server**:
   Compile the TypeScript files into JavaScript:
   ```bash
   npm run build
   ```

---

## Configuring with LM Studio

There are two ways to load this MCP server in LM Studio:

### Method 1: Edit the `mcp.json` Configuration File (Recommended)
You can directly add the configuration to your local LM Studio MCP configuration file (typically located at `~/.lmstudio/mcp.json` on macOS/Linux).

1. Open `~/.lmstudio/mcp.json` in your favorite editor:
   ```bash
   nano ~/.lmstudio/mcp.json
   ```
2. Add the server entry to the `mcpServers` object:
   ```json
   {
     "mcpServers": {
       "lms-ssh-client-mcp": {
         "command": "node",
         "args": [
           "/Users/ethan/desktop/projects/lms-ssh-client-mcp/LMS-SSH-Client-MCP/dist/index.js"
         ]
       }
     }
   }
   ```
3. Save the file and restart LM Studio.

### Method 2: Configure via the LM Studio UI
1. Open **LM Studio**.
2. Go to the **Developer Tools** tab (gear icon on the left sidebar / developer settings).
3. Scroll down to the **Model Context Protocol (MCP)** section.
4. Click **Add Server** and enter the following settings:
   - **Name**: `lms-ssh-client-mcp`
   - **Type**: `stdio`
   - **Command**: `node`
   - **Arguments**: `["/Users/ethan/desktop/projects/lms-ssh-client-mcp/LMS-SSH-Client-MCP/dist/index.js"]` (Make sure to use the absolute path to your compiled `dist/index.js`)
5. Click **Save** to start the server.

---

## Configuring with Claude Desktop

To use this server with Claude Desktop, add it to your `claude_desktop_config.json` (located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ssh-client": {
      "command": "node",
      "args": ["/Users/ethan/desktop/projects/lms-ssh-client-mcp/LMS-SSH-Client-MCP/dist/index.js"]
    }
  }
}
```

---

## Tools Reference

The server exposes the following tools to the LLM:

### 1. `ssh_connect`
Connect to a remote server and get back a `connectionId`.
- **Arguments**:
  - `host` (string, required): Hostname or IP address.
  - `port` (number, default: `22`): Port number.
  - `username` (string, required): SSH username.
  - `password` (string, optional): SSH password.
  - `privateKey` (string, optional): Raw SSH private key text OR a path to the local key file (e.g., `~/.ssh/id_rsa`).
  - `passphrase` (string, optional): Decryption passphrase for the private key if it is encrypted.
  - `readyTimeout` (number, default: `20000`): Connection timeout in milliseconds.

### 2. `ssh_execute_command`
Execute shell commands on the remote machine.
- **Arguments**:
  - `connectionId` (string, required): The ID returned by `ssh_connect`.
  - `command` (string, required): The shell command to run (e.g. `cd /var/www && ls -la && tail -n 20 error.log`).
  - `timeoutMs` (number, default: `30000`): Command execution timeout.

> [!NOTE]
> Environment state (like current working directory `cd`) is **not** preserved between individual `ssh_execute_command` tool calls. To perform multiple operations in the same folder or with the same variables, run them as a combined command using standard shell operators (e.g., `cd /app && npm install && npm run build`).

### 3. `ssh_list_connections`
Lists all active connections (shows `connectionId`, `host`, `username`, `port`, `connectedAt`).
- **Arguments**: None.

### 4. `ssh_close_connection`
Terminate an active SSH connection cleanly.
- **Arguments**:
  - `connectionId` (string, required): Connection to close.

### 5. `ssh_sftp_list_dir`
Inspect folders on the remote system using SFTP.
- **Arguments**:
  - `connectionId` (string, required)
  - `path` (string, required): Remote path to inspect (e.g., `/etc` or `.`).

### 6. `ssh_sftp_read_file`
Read remote files securely.
- **Arguments**:
  - `connectionId` (string, required)
  - `path` (string, required): File path to read.
  - `encoding` (string, default: `"utf8"`): Encoding of the content (use `"base64"` for binary files).

### 7. `ssh_sftp_write_file`
Write/upload files to the remote server.
- **Arguments**:
  - `connectionId` (string, required)
  - `path` (string, required): File path to write.
  - `content` (string, required): File content text or base64-encoded binary.
  - `encoding` (string, default: `"utf8"`)

### 8. `ssh_sftp_delete_file`
Delete files on the remote server.
- **Arguments**:
  - `connectionId` (string, required)
  - `path` (string, required): File path to delete.

### 9. `ssh_sftp_mkdir` / `ssh_sftp_rmdir`
Create directories or delete empty directories.
- **Arguments**:
  - `connectionId` (string, required)
  - `path` (string, required): Directory path.

### 10. `ssh_sftp_rename`
Rename or move a remote file or folder.
- **Arguments**:
  - `connectionId` (string, required)
  - `oldPath` (string, required)
  - `newPath` (string, required)

---

## Development & Debugging

Since stdio is used for MCP JSON-RPC communication, **do not log to `stdout` (`console.log`)** in your code as it will break the protocol parser.
All log messages inside this server are written to `stderr` (`console.error`), which will appear in your LLM client's debug logs (e.g., in LM Studio's MCP log view).
