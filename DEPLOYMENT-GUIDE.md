# Deployment Guide

Follow these steps to publish your Claude Code Docker container to the Unraid community.

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Set repository name: `claude-code-docker`
3. Description: `Docker container for Claude Code with web-based terminal for Unraid`
4. Make it **Public** (required for Unraid Community Apps)
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click **Create repository**

## Step 2: Add Icon (Important!)

Before pushing, you need to add an icon:

1. Download the Anthropic logo or create a custom 256x256px PNG icon
2. Save it as `icon.png` in the repository root
3. Run:
   ```bash
   cd C:/Coding/claude-code-docker
   git add icon.png
   git commit -m "Add icon"
   ```

**Temporary Option**: Use a placeholder until you get a proper icon:
```bash
# This will be addressed in ICON-TODO.md
```

## Step 3: Push to GitHub

```bash
cd C:/Coding/claude-code-docker

# Add remote (replace with your actual repo URL from Step 1)
git remote add origin https://github.com/Jacob-Lasky/claude-code-docker.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 4: Enable GitHub Container Registry

The GitHub Actions workflow will automatically build and push your Docker image to GitHub Container Registry (GHCR).

1. Go to your repository on GitHub
2. Click **Actions** tab
3. The workflow should run automatically after your first push
4. Once complete, go to **Packages** (on the right sidebar of your profile or repo)
5. Find the `claude-code` package
6. Click **Package settings**
7. Scroll down to **Danger Zone** → **Change visibility**
8. Set to **Public** (required for Unraid to pull the image)

## Step 5: Verify the Build

1. Check that the GitHub Action completed successfully
2. Verify the image is available at: `ghcr.io/jacob-lasky/claude-code:latest`
3. Test pulling the image:
   ```bash
   docker pull ghcr.io/jacob-lasky/claude-code:latest
   ```

## Step 6: Test the Template

Before submitting to Community Apps, test your template:

1. Copy `claude-code.xml` to your Unraid server:
   ```bash
   scp claude-code.xml tower:/boot/config/plugins/dockerMan/templates-user/
   ```

2. In Unraid:
   - Go to Docker tab → Add Container
   - Select the template
   - Test that it installs and runs correctly

## Step 7: Submit to Unraid Community Applications

Once everything is working:

1. Fork the Community Applications repository:
   - Go to https://github.com/Squidly271/AppFeed
   - Click **Fork** (top right)

2. Add your template:
   - In your forked repo, navigate to the appropriate subfolder
   - Create a new folder: `Jacob-Lasky-Repository` (or similar)
   - Add your repository info

3. Create a Pull Request:
   - Go to https://github.com/Squidly271/AppFeed/pulls
   - Click **New Pull Request**
   - Select your fork
   - Title: `Add Claude Code Docker container`
   - Description: Brief description of what your container does
   - Submit the PR

**Alternative (Recommended for first-time contributors)**:
Post in the Unraid forums requesting to be added:
- Forum: https://forums.unraid.net/forum/50-docker-containers/
- Include your GitHub repository URL
- Community moderators will help you get added

## Step 8: Maintain Your Container

Once published:

- **Updates**: Push changes to your GitHub repo
  - GitHub Actions will automatically build new images
  - Users will get updates when they update containers in Unraid

- **Issues**: Monitor GitHub Issues for user reports

- **Versioning**: Use git tags for releases:
  ```bash
  git tag -a v1.0.0 -m "Release v1.0.0"
  git push origin v1.0.0
  ```

## Quick Reference

- **Repository**: https://github.com/Jacob-Lasky/claude-code-docker
- **Docker Image**: ghcr.io/jacob-lasky/claude-code:latest
- **Template URL**: https://raw.githubusercontent.com/Jacob-Lasky/claude-code-docker/main/claude-code.xml
- **Icon URL**: https://raw.githubusercontent.com/Jacob-Lasky/claude-code-docker/main/icon.png

## Troubleshooting

### GitHub Actions fails
- Check the Actions tab for error logs
- Verify you haven't hit API rate limits
- Ensure the Dockerfile builds locally first

### Image not available
- Check that the package visibility is set to Public
- Verify the GitHub Actions workflow completed successfully

### Template not appearing in Unraid
- Check the XML syntax is valid
- Ensure all URLs are correct and accessible
- Try refreshing the Docker page in Unraid

## Need Help?

- **Unraid Forums**: https://forums.unraid.net/
- **Community Apps Thread**: Search for "Community Applications" in forums
- **GitHub Issues**: Open an issue in your repository
