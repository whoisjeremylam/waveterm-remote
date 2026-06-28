// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// GitStatusCommand returns the working tree status for a git repository
func (impl *ServerImpl) GitStatusCommand(ctx context.Context, data wshrpc.CommandGitStatusData) (*wshrpc.GitStatusResponse, error) {
	dir := data.Dir
	if dir == "" {
		return nil, fmt.Errorf("directory is required")
	}

	// Get current branch - return empty status if not a git repo
	branch, err := runGitCommand(ctx, dir, "branch", "--show-current")
	if err != nil {
		// Not a git repository - return valid empty response
		return &wshrpc.GitStatusResponse{
			Branch:    "",
			Staged:    []wshrpc.GitFileChange{},
			Unstaged:  []wshrpc.GitFileChange{},
			Untracked: []wshrpc.GitFileChange{},
		}, nil
	}
	branch = strings.TrimSpace(branch)

	// Get status in porcelain v2 format
	statusOutput, err := runGitCommand(ctx, dir, "status", "--porcelain=v2")
	if err != nil {
		return nil, fmt.Errorf("git status failed: %w", err)
	}

	response := &wshrpc.GitStatusResponse{
		Branch:    branch,
		Staged:    []wshrpc.GitFileChange{},
		Unstaged:  []wshrpc.GitFileChange{},
		Untracked: []wshrpc.GitFileChange{},
	}

	lines := strings.Split(statusOutput, "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		change := parseGitStatusLine(line)
		if change == nil {
			continue
		}

		switch {
		case change.Status == "?":
			response.Untracked = append(response.Untracked, *change)
		case strings.HasPrefix(line, "1 ") || strings.HasPrefix(line, "2 "):
			// Porcelain v2: "1 XY sub mH mI mW path" or "2 XY sub mH mI mW oH oM oW path"
			parts := strings.Split(line, " ")
			if len(parts) < 7 {
				continue
			}
			xy := parts[1]
			indexStatus := xy[0:1]
			worktreeStatus := xy[1:2]

			if indexStatus != "." && indexStatus != "?" {
				// Staged change
				response.Staged = append(response.Staged, *change)
			}
			if worktreeStatus != "." && worktreeStatus != "?" {
				// Unstaged change
				response.Unstaged = append(response.Unstaged, *change)
			}
		}
	}

	return response, nil
}

// GitDiffCommand returns the diff for a single file
func (impl *ServerImpl) GitDiffCommand(ctx context.Context, data wshrpc.CommandGitDiffData) (*wshrpc.GitDiffResponse, error) {
	impl.Log("[SCM-DIFF] RECEIVED: dir=%q path=%q staged=%v untracked=%v\n",
		data.Dir, data.Path, data.Staged, data.Untracked)
	dir := data.Dir
	if dir == "" {
		return nil, fmt.Errorf("directory is required")
	}
	path := data.Path
	if path == "" {
		return nil, fmt.Errorf("file path is required")
	}

	fmt.Printf("[SCM] GitDiffCommand: dir=%s, path=%s, staged=%v, untracked=%v\n", dir, path, data.Staged, data.Untracked)

	// For untracked files, read the file content directly since git diff produces empty output
	if data.Untracked {
		fullPath := filepath.Join(dir, path)
		fmt.Printf("[SCM] Reading untracked file: %s\n", fullPath)
		content, err := os.ReadFile(fullPath)
		if err != nil {
			fmt.Printf("[SCM] Failed to read file: %v\n", err)
			return nil, fmt.Errorf("failed to read file: %w", err)
		}
		fmt.Printf("[SCM] File content length: %d bytes\n", len(content))
		language := detectLanguage(path)
		return &wshrpc.GitDiffResponse{
			Original: "",
			Modified: string(content),
			Language: language,
		}, nil
	}

	var args []string
	if data.Staged {
		args = []string{"diff", "--cached", "--", path}
	} else {
		args = []string{"diff", "--", path}
	}

	diffOutput, err := runGitCommand(ctx, dir, args...)
	if err != nil {
		return nil, fmt.Errorf("git diff failed: %w", err)
	}

	// Parse unified diff into original/modified
	original, modified := parseUnifiedDiff(diffOutput)

	// Parse hunks for gutter toolbar
	hunks := parseDiffHunks(diffOutput)

	// Detect language from file extension
	language := detectLanguage(path)

	return &wshrpc.GitDiffResponse{
		Original: original,
		Modified: modified,
		Language: language,
		Hunks:    hunks,
	}, nil
}

// GitStageCommand stages files: git add -A -- <paths>
func (impl *ServerImpl) GitStageCommand(ctx context.Context, data wshrpc.CommandGitStageData) error {
	if data.Dir == "" {
		return fmt.Errorf("directory is required")
	}
	if len(data.Paths) == 0 {
		return nil
	}
	fmt.Printf("[SCM] GitStageCommand: dir=%s, paths=%v\n", data.Dir, data.Paths)
	args := append([]string{"add", "-A", "--"}, data.Paths...)
	output, err := runGitCommand(ctx, data.Dir, args...)
	if err != nil {
		fmt.Printf("[SCM] GitStageCommand failed: %v, output: %s\n", err, output)
	}
	return err
}

// GitUnstageCommand unstages files: git reset -q HEAD -- <paths>
func (impl *ServerImpl) GitUnstageCommand(ctx context.Context, data wshrpc.CommandGitUnstageData) error {
	if data.Dir == "" {
		return fmt.Errorf("directory is required")
	}
	if len(data.Paths) == 0 {
		return nil
	}
	args := append([]string{"reset", "-q", "HEAD", "--"}, data.Paths...)
	_, err := runGitCommand(ctx, data.Dir, args...)
	return err
}

// GitStageHunkCommand stages a single hunk using git apply --cached
func (impl *ServerImpl) GitStageHunkCommand(ctx context.Context, data wshrpc.CommandGitStageHunkData) error {
	if data.Dir == "" {
		return fmt.Errorf("directory is required")
	}
	// Get full diff for unstaged changes
	diffOutput, err := runGitCommand(ctx, data.Dir, "diff", "--", data.Path)
	if err != nil {
		return fmt.Errorf("git diff failed: %w", err)
	}
	// Parse hunks and extract the target hunk
	hunks := parseDiffHunks(diffOutput)
	if data.HunkIndex < 0 || data.HunkIndex >= len(hunks) {
		return fmt.Errorf("hunk index %d out of range (0-%d)", data.HunkIndex, len(hunks)-1)
	}
	// Build a minimal patch for just that hunk
	patch := extractHunkPatch(diffOutput, data.Path, data.HunkIndex)
	// Apply via stdin to git apply --cached
	return applyPatchCached(ctx, data.Dir, patch)
}

// GitRevertHunkCommand discards a hunk's changes
func (impl *ServerImpl) GitRevertHunkCommand(ctx context.Context, data wshrpc.CommandGitRevertHunkData) error {
	if data.Dir == "" {
		return fmt.Errorf("directory is required")
	}
	var diffOutput string
	var err error
	if data.Staged {
		diffOutput, err = runGitCommand(ctx, data.Dir, "diff", "--cached", "--", data.Path)
	} else {
		diffOutput, err = runGitCommand(ctx, data.Dir, "diff", "--", data.Path)
	}
	if err != nil {
		return fmt.Errorf("git diff failed: %w", err)
	}
	hunks := parseDiffHunks(diffOutput)
	if data.HunkIndex < 0 || data.HunkIndex >= len(hunks) {
		return fmt.Errorf("hunk index %d out of range", data.HunkIndex)
	}
	// Build inverse patch (swap + and - lines)
	patch := extractHunkInversePatch(diffOutput, data.Path, data.HunkIndex)
	return applyPatch(ctx, data.Dir, patch)
}

// GitCommitCommand commits staged changes with a message
func (impl *ServerImpl) GitCommitCommand(ctx context.Context, data wshrpc.CommandGitCommitData) (*wshrpc.GitCommitResponse, error) {
	if data.Dir == "" {
		return nil, fmt.Errorf("directory is required")
	}
	if data.Message == "" {
		return nil, fmt.Errorf("commit message is required")
	}

	var args []string
	if data.Amend {
		args = []string{"commit", "--amend", "-m", data.Message}
	} else {
		args = []string{"commit", "-m", data.Message}
	}

	output, err := runGitCommand(ctx, data.Dir, args...)
	if err != nil {
		return &wshrpc.GitCommitResponse{
			Success: false,
			Output:  output + "\n" + err.Error(),
		}, nil
	}

	return &wshrpc.GitCommitResponse{
		Success: true,
		Output:  output,
	}, nil
}

// GitPushCommand pushes changes to remote
func (impl *ServerImpl) GitPushCommand(ctx context.Context, data wshrpc.CommandGitPushData) (*wshrpc.GitPushResponse, error) {
	if data.Dir == "" {
		return nil, fmt.Errorf("directory is required")
	}

	args := []string{"push"}

	if data.Force {
		args = append(args, "--force")
	}
	if data.SetUpstream {
		args = append(args, "--set-upstream")
	}

	remote := data.Remote
	if remote == "" {
		remote = "origin"
	}
	args = append(args, remote)

	branch := data.Branch
	if branch == "" {
		// Get current branch
		branchOutput, err := runGitCommand(ctx, data.Dir, "branch", "--show-current")
		if err != nil {
			return &wshrpc.GitPushResponse{
				Success: false,
				Output:  "Failed to get current branch: " + err.Error(),
			}, nil
		}
		branch = strings.TrimSpace(branchOutput)
	}
	if branch != "" {
		args = append(args, branch)
	}

	// Check if there are unpushed commits before prompting for auth
	if data.Username == "" && data.Password == "" {
		hasUnpushed, err := checkUnpushedCommits(ctx, data.Dir, remote, branch)
		if err == nil && !hasUnpushed {
			return &wshrpc.GitPushResponse{
				Success: true,
				Output:  "Everything up-to-date",
			}, nil
		}
	}

	// Get remote URL for auth error reporting
	remoteURL, err := runGitCommand(ctx, data.Dir, "remote", "get-url", remote)
	if err != nil {
		// Try getting URL from git config
		remoteURL, _ = runGitCommand(ctx, data.Dir, "config", "--get", "remote."+remote+".url")
	}
	remoteURL = strings.TrimSpace(remoteURL)
	authHost := parseHostFromURL(remoteURL)

	// If credentials provided, use GIT_ASKPASS
	var cmd *exec.Cmd
	if data.Username != "" || data.Password != "" {
		credScript := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\n*Username*) echo %q;;\n*Password*) echo %q;;\nesac\n", data.Username, data.Password)
		f, err := os.CreateTemp("", "wave-git-askpass-*.sh")
		if err != nil {
			return &wshrpc.GitPushResponse{
				Success: false,
				Output:  "Failed to create credential script: " + err.Error(),
			}, nil
		}
		scriptPath := f.Name()
		if _, err := f.Write([]byte(credScript)); err != nil {
			f.Close()
			return &wshrpc.GitPushResponse{
				Success: false,
				Output:  "Failed to write credential script: " + err.Error(),
			}, nil
		}
		if err := f.Chmod(0700); err != nil {
			f.Close()
			return &wshrpc.GitPushResponse{
				Success: false,
				Output:  "Failed to chmod credential script: " + err.Error(),
			}, nil
		}
		f.Close()
		defer os.Remove(scriptPath)

		cmd = exec.CommandContext(ctx, "git", args...)
		cmd.Dir = data.Dir
		cmd.Env = append(os.Environ(), "GIT_ASKPASS="+scriptPath)
	} else {
		cmd = exec.CommandContext(ctx, "git", args...)
		cmd.Dir = data.Dir
	}

	output, err := cmd.CombinedOutput()
	outputStr := string(output)

	if err != nil {
		// Check if this is an auth error
		authNeeded := isGitAuthError(outputStr)
		return &wshrpc.GitPushResponse{
			Success:    false,
			Output:     outputStr,
			AuthNeeded: authNeeded,
			AuthError:  outputStr,
			AuthHost:   authHost,
			AuthRemote: remoteURL,
		}, nil
	}

	return &wshrpc.GitPushResponse{
		Success: true,
		Output:  outputStr,
	}, nil
}

// isGitAuthError checks if the git output indicates an auth error
func isGitAuthError(output string) bool {
	authIndicators := []string{
		"Username for",
		"Password for",
		"Authentication failed",
		"Could not read from remote repository",
		"Permission denied",
		"fatal: Authentication failed",
	}
	for _, indicator := range authIndicators {
		if strings.Contains(output, indicator) {
			return true
		}
	}
	return false
}

// parseHostFromURL extracts the host from a git remote URL
// Examples:
//   - https://github.com/user/repo → github.com
//   - git@github.com:user/repo → github.com
//   - ssh://git@github.com/user/repo → github.com
func parseHostFromURL(remoteURL string) string {
	if remoteURL == "" {
		return ""
	}

	// Handle SSH SCP-style format: git@host:path (must check before URL-style)
	if strings.Contains(remoteURL, "@") && !strings.HasPrefix(remoteURL, "ssh://") && !strings.HasPrefix(remoteURL, "https://") && !strings.HasPrefix(remoteURL, "http://") {
		parts := strings.Split(remoteURL, "@")
		if len(parts) == 2 {
			hostPart := strings.SplitN(parts[1], ":", 2)[0]
			if hostPart != "" {
				return hostPart
			}
		}
	}

	// Handle URL format (HTTPS, HTTP, SSH)
	url := remoteURL
	if strings.HasPrefix(url, "https://") {
		url = strings.TrimPrefix(url, "https://")
	} else if strings.HasPrefix(url, "http://") {
		url = strings.TrimPrefix(url, "http://")
	} else if strings.HasPrefix(url, "ssh://") {
		url = strings.TrimPrefix(url, "ssh://")
		if strings.Contains(url, "@") {
			url = strings.SplitN(url, "@", 2)[1]
		}
	}

	// Remove path and any trailing slashes
	host := strings.Split(url, "/")[0]
	// Remove port if present
	if strings.Contains(host, ":") {
		host = strings.Split(host, ":")[0]
	}

	return host
}

// parsePathFromURL extracts owner/repo from a git remote URL
// Examples:
//   - https://github.com/user/repo → user/repo
//   - git@github.com:user/repo → user/repo
func parsePathFromURL(remoteURL string) string {
	if remoteURL == "" {
		return ""
	}

	// Handle SSH SCP-style format: git@host:path (must check before URL-style)
	if strings.Contains(remoteURL, "@") && !strings.HasPrefix(remoteURL, "ssh://") && !strings.HasPrefix(remoteURL, "https://") && !strings.HasPrefix(remoteURL, "http://") {
		parts := strings.Split(remoteURL, "@")
		if len(parts) == 2 {
			pathParts := strings.SplitN(parts[1], ":", 2)
			if len(pathParts) == 2 {
				return strings.TrimSuffix(pathParts[1], ".git")
			}
		}
	}

	// Handle URL format (HTTPS, HTTP, SSH)
	url := remoteURL
	if strings.HasPrefix(url, "https://") {
		url = strings.TrimPrefix(url, "https://")
	} else if strings.HasPrefix(url, "http://") {
		url = strings.TrimPrefix(url, "http://")
	} else if strings.HasPrefix(url, "ssh://") {
		url = strings.TrimPrefix(url, "ssh://")
		if strings.Contains(url, "@") {
			url = strings.SplitN(url, "@", 2)[1]
		}
	}

	// Remove host
	parts := strings.SplitN(url, "/", 2)
	if len(parts) == 2 {
		path := parts[1]
		// Remove .git suffix
		path = strings.TrimSuffix(path, ".git")
		// Remove trailing slash
		path = strings.TrimSuffix(path, "/")
		return path
	}

	return ""
}

// detectProtocolFromURL returns "https" or "ssh" from a git remote URL
func detectProtocolFromURL(remoteURL string) string {
	if strings.HasPrefix(remoteURL, "https://") || strings.HasPrefix(remoteURL, "http://") {
		return "https"
	}
	return "ssh"
}

// checkUnpushedCommits checks if there are commits to push
func checkUnpushedCommits(ctx context.Context, dir, remote, branch string) (bool, error) {
	// First check if upstream is set
	upstreamOutput, err := runGitCommand(ctx, dir, "rev-parse", "--abbrev-ref", "@{upstream}")
	if err != nil {
		// No upstream set, check if remote branch exists
		remoteBranchOutput, err := runGitCommand(ctx, dir, "branch", "-r", "--list", remote+"/"+branch)
		if err != nil || remoteBranchOutput == "" {
			// No remote branch exists, check if there are any local commits
			localCommits, err := runGitCommand(ctx, dir, "rev-list", "--count", "HEAD")
			if err != nil {
				return false, err
			}
			count := strings.TrimSpace(localCommits)
			return count != "0", nil
		}
		// Remote branch exists but no upstream, assume there are things to push
		return true, nil
	}

	// Upstream is set, check if there are unpushed commits
	upstream := strings.TrimSpace(upstreamOutput)
	unpushedOutput, err := runGitCommand(ctx, dir, "rev-list", "--count", upstream+"..HEAD")
	if err != nil {
		return false, err
	}

	count := strings.TrimSpace(unpushedOutput)
	return count != "0", nil
}

// encodeSecretName converts a git secret key (protocol, host, path) to a
// secret-store-safe name using underscores. This avoids characters (:, /, .)
// that the secret store regex rejects.
// Examples:
//   - https, github.com, user/repo → git_https_github_com_user_repo
//   - ssh, github.com, ""          → git_ssh_github_com
func encodeSecretName(protocol, host, path string) string {
	safeHost := strings.NewReplacer(":", "_", ".", "_", "/", "_").Replace(host)
	name := "git_" + protocol + "_" + safeHost
	if path != "" {
		safePath := strings.NewReplacer(":", "_", ".", "_", "/", "_").Replace(path)
		name += "_" + safePath
	}
	return name
}

// GitLookupCredentials looks up stored credentials for a remote
func (impl *ServerImpl) GitLookupCredentialsCommand(ctx context.Context, data wshrpc.CommandGitLookupCredentialsData) (*wshrpc.GitCredentials, error) {
	remote := data.Remote
	if remote == "" {
		return &wshrpc.GitCredentials{Found: false}, nil
	}

	host := parseHostFromURL(remote)
	path := parsePathFromURL(remote)
	protocol := detectProtocolFromURL(remote)

	if host == "" {
		return &wshrpc.GitCredentials{Found: false}, nil
	}

	// Try repo-specific secret first, then host-wide
	secretNames := make([]string, 0, 2)
	if path != "" {
		pathParts := strings.Split(path, "/")
		if len(pathParts) >= 2 {
			ownerRepo := strings.Join(pathParts[:2], "/")
			secretNames = append(secretNames, encodeSecretName(protocol, host, ownerRepo))
		}
	}
	secretNames = append(secretNames, encodeSecretName(protocol, host, ""))

	// Try each secret name
	for _, secretName := range secretNames {
		value, exists, err := secretstore.GetSecret(secretName)
		if err != nil || !exists {
			continue
		}

		// Parse JSON value
		var creds struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.Unmarshal([]byte(value), &creds); err != nil {
			continue
		}

		if creds.Username == "" || creds.Password == "" {
			continue
		}

		scope := "host"
		if secretNames[0] == secretName {
			scope = "repo"
		}

		return &wshrpc.GitCredentials{
			Username: creds.Username,
			Password: creds.Password,
			Found:    true,
			Scope:    scope,
		}, nil
	}

	return &wshrpc.GitCredentials{Found: false}, nil
}

// GitSaveCredentials saves credentials to the secret store
func (impl *ServerImpl) GitSaveCredentialsCommand(ctx context.Context, data wshrpc.CommandGitSaveCredentialsData) error {
	remote := data.Remote
	if remote == "" {
		return fmt.Errorf("remote is required")
	}

	host := parseHostFromURL(remote)
	path := parsePathFromURL(remote)
	protocol := detectProtocolFromURL(remote)

	if host == "" {
		return fmt.Errorf("invalid remote URL")
	}

	// Determine secret name based on scope
	var secretName string
	if data.Scope == "repo" && path != "" {
		pathParts := strings.Split(path, "/")
		if len(pathParts) >= 2 {
			ownerRepo := strings.Join(pathParts[:2], "/")
			secretName = encodeSecretName(protocol, host, ownerRepo)
		}
	}
	if secretName == "" {
		secretName = encodeSecretName(protocol, host, "")
	}

	// Create JSON value with username and password
	creds := struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}{
		Username: data.Username,
		Password: data.Password,
	}

	jsonBytes, err := json.Marshal(creds)
	if err != nil {
		return fmt.Errorf("failed to marshal credentials: %w", err)
	}

	return secretstore.SetSecret(secretName, string(jsonBytes))
}

// runGitCommand runs a git command in the specified directory
func runGitCommand(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %s", strings.Join(args, " "), string(output))
	}
	return string(output), nil
}

// parseGitStatusLine parses a single line from git status --porcelain=v2
func parseGitStatusLine(line string) *wshrpc.GitFileChange {
	if len(line) < 3 {
		return nil
	}

	// Skip header lines (e.g., "# branch.oid ...")
	if strings.HasPrefix(line, "#") {
		return nil
	}

	var status, path, oldPath string

	if strings.HasPrefix(line, "1 ") || strings.HasPrefix(line, "2 ") {
		// Porcelain v2 type 1: "1 XY sub mH mI mW path"
		// Porcelain v2 type 2: "2 XY sub mH mI mW oH oM oW path" (for renames)
		parts := strings.Split(line, " ")
		if len(parts) < 7 {
			return nil
		}
		xy := parts[1]
		// Path is always the last field (handles paths with spaces correctly)
		path = parts[len(parts)-1]

		// Handle renames (type 2 has extra fields before path)
		if strings.HasPrefix(line, "2 ") && len(parts) >= 10 {
			oldPath = parts[len(parts)-2]
		}

		// Determine status from XY codes
		indexStatus := xy[0:1]
		worktreeStatus := xy[1:2]

		switch {
		case indexStatus == "A" || worktreeStatus == "A":
			status = "A"
		case indexStatus == "D" || worktreeStatus == "D":
			status = "D"
		case indexStatus == "R" || worktreeStatus == "R":
			status = "R"
		case indexStatus == "C" || worktreeStatus == "C":
			status = "C"
		default:
			status = "M"
		}
	} else if strings.HasPrefix(line, "? ") {
		// Untracked file
		status = "?"
		path = strings.TrimPrefix(line, "? ")
	} else if strings.HasPrefix(line, "u ") {
		// Unmerged file
		status = "U"
		parts := strings.SplitN(line, " ", 7)
		if len(parts) >= 7 {
			path = parts[6]
		}
	} else {
		return nil
	}

	icon, color := getStatusIcon(status)

	return &wshrpc.GitFileChange{
		Path:    path,
		Status:  status,
		OldPath: oldPath,
		Icon:    icon,
		Color:   color,
	}
}

// getStatusIcon returns the icon and color for a git status code
func getStatusIcon(status string) (string, string) {
	switch status {
	case "M":
		return "fa-file-pen", "#f0a30a" // yellow
	case "A":
		return "fa-file-circle-plus", "#73c991" // green
	case "D":
		return "fa-file-circle-minus", "#f14c4c" // red
	case "R":
		return "fa-file-circle-arrow-right", "#73c991" // green
	case "C":
		return "fa-file-circle-check", "#73c991" // green
	case "U":
		return "fa-file-circle-exclamation", "#f0a30a" // yellow
	case "?":
		return "fa-file-circle-question", "#73c991" // green
	default:
		return "fa-file", "#ffffff" // white
	}
}

// parseUnifiedDiff parses a unified diff output into original and modified strings
func parseUnifiedDiff(diff string) (string, string) {
	var original, modified strings.Builder
	lines := strings.Split(diff, "\n")

	inHunk := false
	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			inHunk = true
			continue
		}
		if !inHunk {
			continue
		}

		if strings.HasPrefix(line, "-") {
			original.WriteString(line[1:])
			original.WriteString("\n")
		} else if strings.HasPrefix(line, "+") {
			modified.WriteString(line[1:])
			modified.WriteString("\n")
		} else if strings.HasPrefix(line, " ") {
			// Context line - appears in both
			content := line[1:]
			original.WriteString(content)
			original.WriteString("\n")
			modified.WriteString(content)
			modified.WriteString("\n")
		}
	}

	return original.String(), modified.String()
}

// detectLanguage returns the Monaco language ID based on file extension
func detectLanguage(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx", ".mjs", ".cjs":
		return "javascript"
	case ".py":
		return "python"
	case ".go":
		return "go"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".c", ".h":
		return "c"
	case ".cpp", ".cc", ".cxx", ".hpp":
		return "cpp"
	case ".rb":
		return "ruby"
	case ".php":
		return "php"
	case ".swift":
		return "swift"
	case ".kt", ".kts":
		return "kotlin"
	case ".cs":
		return "csharp"
	case ".json":
		return "json"
	case ".xml":
		return "xml"
	case ".yaml", ".yml":
		return "yaml"
	case ".md", ".mdx":
		return "markdown"
	case ".css":
		return "css"
	case ".scss", ".sass":
		return "scss"
	case ".less":
		return "less"
	case ".html", ".htm":
		return "html"
	case ".sql":
		return "sql"
	case ".sh", ".bash":
		return "shell"
	case ".dockerfile":
		return "dockerfile"
	case ".toml":
		return "ini"
	case ".ini", ".cfg":
		return "ini"
	case ".txt":
		return "plaintext"
	default:
		return "plaintext"
	}
}

// DiffHunk represents a parsed hunk from unified diff output
type DiffHunk struct {
	Header   string
	StartLine int
	Lines    []string
}

// parseDiffHunks extracts individual hunks from unified diff output
func parseDiffHunks(diff string) []wshrpc.GitDiffHunk {
	var hunks []wshrpc.GitDiffHunk
	lines := strings.Split(diff, "\n")

	for _, line := range lines {
		if !strings.HasPrefix(line, "@@") {
			continue
		}
		// Parse @@ -a,b +c,d @@ header
		hunk := parseHunkHeader(line)
		if hunk != nil {
			hunks = append(hunks, *hunk)
		}
	}
	return hunks
}

// parseHunkHeader parses a @@ -a,b +c,d @@ line into a GitDiffHunk
func parseHunkHeader(header string) *wshrpc.GitDiffHunk {
	// Find the first @@ and extract the range spec
	idx := strings.Index(header, "@@")
	if idx < 0 {
		return nil
	}
	rest := header[idx+2:]
	endIdx := strings.Index(rest, "@@")
	if endIdx < 0 {
		return nil
	}
	rangeSpec := strings.TrimSpace(rest[:endIdx])

	// Parse "-a,b +c,d"
	hunk := &wshrpc.GitDiffHunk{Header: header}

	// Parse original range: -a,b
	if len(rangeSpec) > 0 && rangeSpec[0] == '-' {
		rangeSpec = rangeSpec[1:]
		commaIdx := strings.Index(rangeSpec, ",")
		spaceIdx := strings.Index(rangeSpec, " ")
		endIdx := commaIdx
		if endIdx < 0 || (spaceIdx >= 0 && spaceIdx < endIdx) {
			endIdx = spaceIdx
		}
		if endIdx < 0 {
			endIdx = len(rangeSpec)
		}
		n, err := strconv.Atoi(rangeSpec[:endIdx])
		if err == nil {
			hunk.OriginalStart = n
		}
		if commaIdx >= 0 {
			rangeSpec = rangeSpec[commaIdx+1:]
			spaceIdx = strings.Index(rangeSpec, " ")
			if spaceIdx < 0 {
				spaceIdx = len(rangeSpec)
			}
			n, err := strconv.Atoi(rangeSpec[:spaceIdx])
			if err == nil {
				hunk.OriginalCount = n
			}
			if spaceIdx < len(rangeSpec) {
				rangeSpec = rangeSpec[spaceIdx:]
			} else {
				rangeSpec = ""
			}
		}
	}

	// Parse modified range: +c,d
	rangeSpec = strings.TrimSpace(rangeSpec)
	if len(rangeSpec) > 0 && rangeSpec[0] == '+' {
		rangeSpec = rangeSpec[1:]
		commaIdx := strings.Index(rangeSpec, ",")
		endIdx := commaIdx
		if endIdx < 0 {
			endIdx = len(rangeSpec)
		}
		n, err := strconv.Atoi(rangeSpec[:endIdx])
		if err == nil {
			hunk.ModifiedStart = n
		}
		if commaIdx >= 0 {
			rangeSpec = rangeSpec[commaIdx+1:]
			n, err := strconv.Atoi(rangeSpec)
			if err == nil {
				hunk.ModifiedCount = n
			}
		}
	}

	return hunk
}

// extractHunkPatch extracts a single hunk from raw diff output and builds a patch
func extractHunkPatch(diff string, path string, hunkIndex int) string {
	lines := strings.Split(diff, "\n")
	hunkLines := extractHunkLines(lines, hunkIndex)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("--- a/%s\n", path))
	b.WriteString(fmt.Sprintf("+++ b/%s\n", path))
	for _, line := range hunkLines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// extractHunkInversePatch extracts a single hunk and builds an inverse patch (revert)
func extractHunkInversePatch(diff string, path string, hunkIndex int) string {
	lines := strings.Split(diff, "\n")
	hunkLines := extractHunkLines(lines, hunkIndex)

	var b strings.Builder
	b.WriteString(fmt.Sprintf("--- a/%s\n", path))
	b.WriteString(fmt.Sprintf("+++ b/%s\n", path))
	for _, line := range hunkLines {
		if strings.HasPrefix(line, "+") {
			b.WriteString("-" + line[1:])
		} else if strings.HasPrefix(line, "-") {
			b.WriteString("+" + line[1:])
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// extractHunkLines extracts the lines of a specific hunk from diff output
func extractHunkLines(lines []string, hunkIndex int) []string {
	currentHunk := -1
	var result []string

	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			currentHunk++
			if currentHunk == hunkIndex {
				result = append(result, line)
				continue
			}
		}
		if currentHunk == hunkIndex && currentHunk >= 0 {
			result = append(result, line)
		}
	}
	return result
}

// applyPatchCached applies a patch to the git index via stdin
func applyPatchCached(ctx context.Context, dir string, patch string) error {
	cmd := exec.CommandContext(ctx, "git", "apply", "--cached")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(patch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git apply --cached failed: %s %w", string(output), err)
	}
	return nil
}

// applyPatch applies a patch to the working tree via stdin
func applyPatch(ctx context.Context, dir string, patch string) error {
	cmd := exec.CommandContext(ctx, "git", "apply")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(patch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git apply failed: %s %w", string(output), err)
	}
	return nil
}
