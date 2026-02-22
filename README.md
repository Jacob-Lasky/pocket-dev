# Claude Code for Unraid

A Docker container that runs [Claude Code](https://github.com/anthropics/claude-code) with a browser-based terminal interface, perfect for Unraid servers.

## Features

- **Browser-based terminal** - Access Claude Code through your web browser via [ttyd](https://github.com/tsl0922/ttyd)
- **Persistent sessions** - Uses tmux to maintain your Claude session even when you close the browser
- **Multi-device access** - Connect from different computers and resume the same session
- **Docker management** - Claude can manage other Docker containers (restart, view logs, etc.)
- **Docker container** - Isolated environment for running Claude Code
- **Unraid template** - Easy installation through Unraid's Docker interface
- **Secure** - Runs as non-root user (uid 99/gid 100 for Unraid compatibility)
- **Persistent storage** - Workspace and config directories are mounted volumes

## What is Claude Code?

Claude Code is Anthropic's official CLI tool that brings Claude's advanced coding capabilities to your terminal. It can help with:
- Writing and refactoring code
- Debugging issues
- Explaining code
- Generating documentation
- And much more!

## Installation

### Unraid Community Applications

1. Open Unraid WebUI
2. Go to **Apps** tab
3. Search for **"claude code"**
4. Click **Install**
5. **(Optional)** Enter your **ANTHROPIC_API_KEY** for automatic authentication
   - Or skip this and use `claude login` on first use
6. Configure paths if needed (defaults are fine)
7. Click **Apply**

### Manual Installation

1. Go to **Docker** tab in Unraid
2. Click **Add Container**
3. Select **Template**: `claude-code` from dropdown
4. **(Optional)** Fill in your **ANTHROPIC_API_KEY**
5. Click **Apply**

## Usage

Once the container is running:

1. **Access the web terminal**: Click the WebUI icon in Unraid, or navigate to `http://YOUR-SERVER-IP:7681`
2. **Authenticate** (if you didn't provide API key):
   - Claude will prompt you to authenticate
   - Run `claude login` and follow the prompts
   - Your authentication persists in the config volume
3. **Start coding**: Claude Code is ready - ask Claude to help with your coding tasks!

### Command Line Access (Alternative)

You can also access Claude Code via SSH:

```bash
# Interactive bash shell
docker exec -it claude-code bash

# Run claude directly
docker exec -it claude-code claude

# Run a specific command
docker exec -it claude-code claude "help me with this code"
```

## Configuration

### Environment Variables

- **ANTHROPIC_API_KEY** (optional): Your Anthropic API key from https://console.anthropic.com/
  - If not provided, use `claude login` in the terminal to authenticate via OAuth

### Ports

- **7681**: Web terminal interface (ttyd)

### Volumes

- **/workspace**: Your working directory where Claude Code can read/write files
  - Default: `/mnt/user/appdata/claude-code/workspace`
- **/home/claude/.claude**: Claude configuration and settings
  - Default: `/mnt/user/appdata/claude-code/config`
- **/var/run/docker.sock**: Docker socket for container management (read-only)
  - Allows Claude to run commands like `docker restart dispatcharr`
  - **Security note**: Provides container management capabilities; read-only mount prevents daemon modification

## Building from Source

### Using Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/Jacob-Lasky/claude-code-docker.git
cd claude-code-docker

# (Optional) Create .env file with your API key
echo "ANTHROPIC_API_KEY=your-api-key" > .env

# Build and start
docker-compose up -d --build

# View logs
docker-compose logs -f
```

### Using Docker CLI

```bash
# Build the image
docker build -t claude-code:latest .

# Run the container
docker run -d \
  --name=claude-code \
  --group-add 281 \
  -e ANTHROPIC_API_KEY=your-api-key \
  -p 7681:7681 \
  -v /mnt/user/appdata/claude-code/workspace:/workspace \
  -v /mnt/user/appdata/claude-code/config:/home/claude/.claude \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  claude-code:latest
```

## Technical Details

- **Base Image**: `node:20-slim`
- **Terminal**: ttyd v1.7.7
- **User**: claude (uid 99, gid 100)
- **Architecture**: Supports amd64 (x86_64) and arm64 (aarch64)

## Troubleshooting

### Container won't start
- Check that you've provided a valid ANTHROPIC_API_KEY
- Ensure ports are not already in use

### Can't access web terminal
- Verify the container is running: `docker ps | grep claude-code`
- Check the port mapping is correct (default: 7681)
- Try accessing via IP address instead of hostname

### Claude command not found
- The `claude` command should be available in PATH automatically
- Try running: `which claude` to verify installation

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - See [LICENSE](LICENSE) file for details

## Links

- [Claude Code Official Repository](https://github.com/anthropics/claude-code)
- [Anthropic Documentation](https://docs.anthropic.com/)
- [ttyd - Terminal over web](https://github.com/tsl0922/ttyd)

## Support

- For issues with this container: [GitHub Issues](https://github.com/Jacob-Lasky/claude-code-docker/issues)
- For Claude Code issues: [Claude Code Issues](https://github.com/anthropics/claude-code/issues)
- For Unraid support: [Unraid Forums](https://forums.unraid.net/)

## Credits

- Created for the Unraid community
- Built with [Claude Code](https://github.com/anthropics/claude-code) by Anthropic
- Web terminal powered by [ttyd](https://github.com/tsl0922/ttyd)
