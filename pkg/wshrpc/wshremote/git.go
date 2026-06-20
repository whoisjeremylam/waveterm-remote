// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// GitStatusCommand returns the working tree status for a git repository
func (impl *ServerImpl) GitStatusCommand(ctx context.Context, data wshrpc.CommandGitStatusData) (*wshrpc.GitStatusResponse, error) {
	dir := data.Dir
	if dir == "" {
		return nil, fmt.Errorf("directory is required")
	}

	// Get current branch
	branch, err := runGitCommand(ctx, dir, "branch", "--show-current")
	if err != nil {
		return nil, fmt.Errorf("not a git repository or git not available: %w", err)
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
	dir := data.Dir
	if dir == "" {
		return nil, fmt.Errorf("directory is required")
	}
	path := data.Path
	if path == "" {
		return nil, fmt.Errorf("file path is required")
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

	// Detect language from file extension
	language := detectLanguage(path)

	return &wshrpc.GitDiffResponse{
		Original: original,
		Modified: modified,
		Language: language,
	}, nil
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
