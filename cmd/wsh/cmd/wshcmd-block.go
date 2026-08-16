// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// blockCmd is the singular "block" command group. It is distinct from the
// existing "blocks" (plural) group; this one operates on a single block.
var blockCmd = &cobra.Command{
	Use:   "block",
	Short: "Manage a single block",
	Long:  "Commands for capturing and controlling a single block.",
}

var blockCaptureCmd = &cobra.Command{
	Use:   "capture <block_ref>",
	Short: "Capture terminal scrollback from a block",
	Long: `Capture the terminal scrollback from a terminal block.

By default, retrieves all lines as text. Use --start/--end for a line range,
--tail for the last N lines, or --last-command for the output of the last
command (requires shell integration).

When --json is given, output is a single JSON object with the shape:

  {
    "lines": ["line 1", "line 2", "..."],
    "totallines": 123,
    "lastupdated": 1690000000000
  }

where "lines" are the captured lines, "totallines" is the total number of
lines in the terminal buffer, and "lastupdated" is the Unix millisecond
timestamp of the last buffer update.`,
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockCaptureRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	blockCaptureStart       int
	blockCaptureEnd         int
	blockCaptureTail        int
	blockCaptureLastCommand bool
	blockCaptureJSON        bool
	blockCaptureOutputFile  string
)

var blockSendKeysCmd = &cobra.Command{
	Use:   "send-keys <block_ref> [text]",
	Short: "Send keystrokes to a terminal block",
	Long: `Send keystrokes to a terminal block as if typed.

The text is the optional positional argument (or use --secret to type a stored
secret's value). By default text is sent literally. Use --escapes to interpret
backslash escape sequences (\uXXXX, \n, \t, \r, \\). Use --enter to append the
Enter key (0x0d) to the input.`,
	Args:                  cobra.MaximumNArgs(2),
	RunE:                  blockSendKeysRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var blockStatusCmd = &cobra.Command{
	Use:   "status <block_ref>",
	Short: "Report the status of a terminal block's process and connection",
	Long: `Report the process and connection status of a terminal block.

By default prints a human-readable summary. With --json, prints a single JSON
object with the shape:

  {
    "processstate": "running" | "exited",
    "exitcode": 0,
    "connection": "prod-server",
    "connstatus": "connected"
  }`,
	Args:                  cobra.MaximumNArgs(1),
	RunE:                  blockStatusRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	blockSendKeysEnter   bool
	blockSendKeysEscapes bool
	blockSendKeysSecret  string
	blockStatusJSON      bool
)

var blockNewCmd = &cobra.Command{
	Use:   "new",
	Short: "Create a new block",
	Long: `Create a new block in a tab.

By default creates a plain terminal block in the current tab. Use --view to
choose the view type, --connection to attach to a connection, --cmd to run a
persistent command, --magnified to open magnified, and --split/--relative-to to
create the block by splitting an existing block.

With --json, output is a single JSON object with the shape:

  {
    "blockid": "<oid>"
  }

Block geometry is not yet reported; it arrives in a later phase.`,
	Args:                  cobra.NoArgs,
	RunE:                  blockNewRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var blockSplitCmd = &cobra.Command{
	Use:   "split <block_ref> --direction left|right|above|below",
	Short: "Create a new block by splitting an existing block",
	Long: `Create a new terminal block by splitting the referenced block in the given
direction.

This is sugar for "block new --split <direction> --relative-to <block_ref>".
The direction vocabulary matches directional addressing: left, right, above,
below.`,
	Args:                  cobra.ExactArgs(1),
	RunE:                  blockSplitRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var blockRenameCmd = &cobra.Command{
	Use:                   "rename <block_ref> <name>",
	Short:                 "Rename a block",
	Long:                  `Set a block's title (frame:title) so it can be found by name later.`,
	Args:                  cobra.ExactArgs(2),
	RunE:                  blockRenameRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	blockNewView       string
	blockNewConnection string
	blockNewCmdStr     string
	blockNewMagnified  bool
	blockNewSplit      string
	blockNewRelativeTo string
	blockNewTab        string
	blockNewJSON       bool

	blockSplitDirection string
	blockSplitJSON      bool
)

func init() {
	addCaptureFlags(blockCaptureCmd)
	addSendKeysFlags(blockSendKeysCmd)
	blockStatusCmd.Flags().BoolVar(&blockStatusJSON, "json", false, "output as JSON")

	blockNewCmd.Flags().StringVar(&blockNewView, "view", "term", "view type (default \"term\")")
	blockNewCmd.Flags().StringVar(&blockNewConnection, "connection", "", "connection name to attach the block to")
	blockNewCmd.Flags().StringVar(&blockNewCmdStr, "cmd", "", "run a persistent command in a terminal block")
	blockNewCmd.Flags().BoolVar(&blockNewMagnified, "magnified", false, "open the block in magnified mode")
	blockNewCmd.Flags().StringVar(&blockNewSplit, "split", "", "split direction: left, right, above, below (requires --relative-to)")
	blockNewCmd.Flags().StringVar(&blockNewRelativeTo, "relative-to", "", "block reference to split (requires --split)")
	blockNewCmd.Flags().StringVar(&blockNewTab, "tab", "", "target tab (tab:N, uuid, or tab ORef; defaults to current tab)")
	blockNewCmd.Flags().BoolVar(&blockNewJSON, "json", false, "output as JSON")

	addSplitFlags(blockSplitCmd)

	blockCmd.AddCommand(blockSendKeysCmd)
	blockCmd.AddCommand(blockStatusCmd)
	blockCmd.AddCommand(blockCaptureCmd)
	blockCmd.AddCommand(blockNewCmd)
	blockCmd.AddCommand(blockSplitCmd)
	blockCmd.AddCommand(blockRenameCmd)
	rootCmd.AddCommand(blockCmd)
}

// addCaptureFlags registers the capture command flags on cmd. It is shared
// between "block capture" and the top-level "capture-pane" alias.
func addCaptureFlags(cmd *cobra.Command) {
	cmd.Flags().IntVar(&blockCaptureStart, "start", 0, "starting line number (0 = beginning)")
	cmd.Flags().IntVar(&blockCaptureEnd, "end", 0, "ending line number (0 = all lines)")
	cmd.Flags().IntVar(&blockCaptureTail, "tail", 0, "return only the last N lines (mutually exclusive with --start/--end)")
	cmd.Flags().BoolVar(&blockCaptureLastCommand, "last-command", false, "get output of last command (requires shell integration)")
	cmd.Flags().BoolVar(&blockCaptureLastCommand, "lastcommand", false, "get output of last command (requires shell integration)")
	cmd.Flags().BoolVar(&blockCaptureJSON, "json", false, "output as JSON (includes totallines and lastupdated)")
	cmd.Flags().StringVarP(&blockCaptureOutputFile, "output", "o", "", "write output to file instead of stdout")
	cmd.Flags().MarkHidden("lastcommand")
}

// addSendKeysFlags registers the send-keys command flags on cmd. It is shared
// between "block send-keys" and the top-level "send-keys" alias.
func addSendKeysFlags(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&blockSendKeysEnter, "enter", false, "append the Enter key to the input")
	cmd.Flags().BoolVar(&blockSendKeysEscapes, "escapes", false, "interpret \\uXXXX, \\n, \\t, \\r, \\\\ escape sequences in the input text")
	cmd.Flags().StringVar(&blockSendKeysSecret, "secret", "", "type the value of a stored secret instead of literal text")
}

// addSplitFlags registers the split command flags on cmd. It is shared between
// "block split" and the top-level "split-pane" alias.
func addSplitFlags(cmd *cobra.Command) {
	cmd.Flags().StringVar(&blockSplitDirection, "direction", "", "split direction: left, right, above, below (required)")
	cmd.Flags().BoolVar(&blockSplitJSON, "json", false, "output as JSON")
}

// blockCaptureJSONOutput is the structured output shape for `block capture --json`.
type blockCaptureJSONOutput struct {
	Lines       []string `json:"lines"`
	TotalLines  int      `json:"totallines"`
	LastUpdated int64    `json:"lastupdated"`
}

// validateCaptureFlags checks the --tail/--start/--end flag combination.
// --tail is mutually exclusive with --start and --end, and must be positive.
func validateCaptureFlags(tailSet, startSet, endSet bool, tail int) error {
	if tailSet && (startSet || endSet) {
		return fmt.Errorf("--tail cannot be combined with --start or --end")
	}
	if tailSet && tail <= 0 {
		return fmt.Errorf("--tail must be a positive integer")
	}
	return nil
}

// tailLines returns the last tail lines of lines. If tail is <= 0 or the
// buffer has fewer than tail lines, it returns all of lines.
func tailLines(lines []string, tail int) []string {
	if tail <= 0 || tail >= len(lines) {
		return lines
	}
	return lines[len(lines)-tail:]
}

func blockCaptureRun(cmd *cobra.Command, args []string) error {
	tailSet := cmd.Flags().Changed("tail")
	startSet := cmd.Flags().Changed("start")
	endSet := cmd.Flags().Changed("end")
	if err := validateCaptureFlags(tailSet, startSet, endSet, blockCaptureTail); err != nil {
		return err
	}

	// Resolve the block reference (positional arg, then -b/--block, then "this").
	blockRef := ""
	if len(args) > 0 {
		blockRef = args[0]
	}
	fullORef, err := resolveBlockArgWithOverride(blockRef)
	if err != nil {
		return err
	}

	// Get block metadata to verify it's a terminal block.
	metaData, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{
		ORef: *fullORef,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("error getting block metadata: %w", err)
	}

	viewType, ok := metaData[waveobj.MetaKey_View].(string)
	if !ok || viewType != "term" {
		return fmt.Errorf("block %s is not a terminal block (view type: %s)", fullORef.OID, viewType)
	}

	// Fetch the scrollback. For --tail we fetch all lines and slice locally so
	// that TotalLines/LastUpdated are surfaced in a single RPC round-trip.
	scrollbackData := wshrpc.CommandTermGetScrollbackLinesData{
		LineStart:   blockCaptureStart,
		LineEnd:     blockCaptureEnd,
		LastCommand: blockCaptureLastCommand,
	}
	if tailSet {
		scrollbackData.LineStart = 0
		scrollbackData.LineEnd = 0
	}

	result, err := wshclient.TermGetScrollbackLinesCommand(RpcClient, scrollbackData, &wshrpc.RpcOpts{
		Route:   wshutil.MakeFeBlockRouteId(fullORef.OID),
		Timeout: 5000,
	})
	if err != nil {
		return fmt.Errorf("error getting terminal scrollback: %w", err)
	}

	lines := result.Lines
	if tailSet {
		lines = tailLines(result.Lines, blockCaptureTail)
	}

	// Format the output.
	var output string
	if blockCaptureJSON {
		bytes, err := json.MarshalIndent(blockCaptureJSONOutput{
			Lines:       lines,
			TotalLines:  result.TotalLines,
			LastUpdated: result.LastUpdated,
		}, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal JSON: %w", err)
		}
		output = string(bytes) + "\n"
	} else {
		output = strings.Join(lines, "\n")
		if len(lines) > 0 {
			output += "\n" // Add final newline
		}
	}

	// Write to file or stdout.
	if blockCaptureOutputFile != "" {
		if err := os.WriteFile(blockCaptureOutputFile, []byte(output), 0644); err != nil {
			return fmt.Errorf("error writing to file %s: %w", blockCaptureOutputFile, err)
		}
		WriteStdout("block capture written to %s (%d lines)\n", blockCaptureOutputFile, len(lines))
	} else {
		WriteStdout("%s", output)
	}

	return nil
}

// blockStatusJSONOutput is the structured output shape for `block status --json`.
type blockStatusJSONOutput struct {
	ProcessState string `json:"processstate"`
	ExitCode     int    `json:"exitcode"`
	Connection   string `json:"connection"`
	ConnStatus   string `json:"connstatus"`
}

// validateSendKeysInput enforces that the positional text argument and --secret
// are mutually exclusive input sources.
func validateSendKeysInput(textSet bool, secret string) error {
	if textSet && secret != "" {
		return fmt.Errorf("cannot specify both a text argument and --secret")
	}
	return nil
}

// decodeEscapes interprets backslash escape sequences in text: \uXXXX (exactly
// 4 hex digits -> Unicode code point), \n (0x0a), \t (0x09), \r (0x0d), and \\
// (a literal backslash). Any other backslash sequence is an error. Characters
// without a preceding backslash are passed through unchanged.
func decodeEscapes(text string) (string, error) {
	var sb strings.Builder
	sb.Grow(len(text))
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if ch != '\\' {
			sb.WriteByte(ch)
			continue
		}
		if i+1 >= len(text) {
			return "", fmt.Errorf("invalid escape sequence: trailing backslash")
		}
		i++
		switch text[i] {
		case '\\':
			sb.WriteByte('\\')
		case 'n':
			sb.WriteByte('\n')
		case 't':
			sb.WriteByte('\t')
		case 'r':
			sb.WriteByte('\r')
		case 'u':
			if i+4 >= len(text) {
				return "", fmt.Errorf("invalid escape sequence: \\u requires exactly 4 hex digits")
			}
			hexStr := text[i+1 : i+5]
			code, err := strconv.ParseUint(hexStr, 16, 32)
			if err != nil {
				return "", fmt.Errorf("invalid escape sequence: \\u%s is not valid hex", hexStr)
			}
			sb.WriteRune(rune(code))
			i += 4
		default:
			return "", fmt.Errorf("invalid escape sequence: \\%c", text[i])
		}
	}
	return sb.String(), nil
}

// appendEnter appends the Enter key (0x0d) to input when enter is true.
func appendEnter(input []byte, enter bool) []byte {
	if enter {
		return append(input, '\r')
	}
	return input
}

// assembleInputBytes builds the byte slice to send: it optionally decodes
// --escapes sequences in text and optionally appends the Enter key.
func assembleInputBytes(text string, enter, escapes bool) ([]byte, error) {
	if escapes {
		decoded, err := decodeEscapes(text)
		if err != nil {
			return nil, err
		}
		text = decoded
	}
	return appendEnter([]byte(text), enter), nil
}

// mapProcessState maps a block controller's ShellProcStatus to the
// "processstate" JSON field. "done" maps to "exited"; every other value
// ("running", "init", and any unknown/empty value) maps to "running", because
// the process is not known to have exited.
func mapProcessState(shellProcStatus string) string {
	if shellProcStatus == "done" {
		return "exited"
	}
	return "running"
}

// lookupConnStatus reports the connection status string for connection based on
// connStatuses. Local connections (empty, "local", or "local:"/"wsl://"
// prefixed) are always "connected". Otherwise the entry matching connection is
// used: "connected" if it reports Connected, else its Status (or "disconnected"
// if the entry has no status). If no entry matches, "disconnected" is returned.
func lookupConnStatus(connStatuses []wshrpc.ConnStatus, connection string) string {
	if !isNonLocalConnName(connection) {
		return "connected"
	}
	for _, cs := range connStatuses {
		if cs.Connection == connection {
			if cs.Connected {
				return "connected"
			}
			if cs.Status != "" {
				return cs.Status
			}
			return "disconnected"
		}
	}
	return "disconnected"
}

// getTermBlockMeta resolves the block ref and returns its metadata, verifying
// the block is a terminal block. Both send-keys and status share this check.
func getTermBlockMeta(blockRef string) (*waveobj.ORef, waveobj.MetaMapType, error) {
	fullORef, err := resolveBlockArgWithOverride(blockRef)
	if err != nil {
		return nil, nil, err
	}
	metaData, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{
		ORef: *fullORef,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return nil, nil, fmt.Errorf("error getting block metadata: %w", err)
	}
	viewType, ok := metaData[waveobj.MetaKey_View].(string)
	if !ok || viewType != "term" {
		return nil, nil, fmt.Errorf("block %s is not a terminal block (view type: %s)", fullORef.OID, viewType)
	}
	return fullORef, metaData, nil
}

func blockSendKeysRun(cmd *cobra.Command, args []string) error {
	blockRef := ""
	text := ""
	textSet := false
	if len(args) > 0 {
		blockRef = args[0]
	}
	if len(args) > 1 {
		text = args[1]
		textSet = true
	}
	if err := validateSendKeysInput(textSet, blockSendKeysSecret); err != nil {
		return err
	}

	fullORef, _, err := getTermBlockMeta(blockRef)
	if err != nil {
		return err
	}

	// Build the input bytes. The secret value is never logged or printed.
	var input []byte
	if blockSendKeysSecret != "" {
		secrets, err := wshclient.GetSecretsCommand(RpcClient, []string{blockSendKeysSecret}, &wshrpc.RpcOpts{Timeout: 2000})
		if err != nil {
			return fmt.Errorf("error resolving secret %q: %w", blockSendKeysSecret, err)
		}
		value, ok := secrets[blockSendKeysSecret]
		if !ok {
			return fmt.Errorf("secret %q not found", blockSendKeysSecret)
		}
		input = appendEnter([]byte(value), blockSendKeysEnter)
	} else {
		input, err = assembleInputBytes(text, blockSendKeysEnter, blockSendKeysEscapes)
		if err != nil {
			return err
		}
	}

	err = wshclient.ControllerInputCommand(RpcClient, wshrpc.CommandBlockInputData{
		BlockId:     fullORef.OID,
		InputData64: base64.StdEncoding.EncodeToString(input),
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("error sending input to block %s: %w", fullORef.OID, err)
	}
	return nil
}

func blockStatusRun(cmd *cobra.Command, args []string) error {
	blockRef := ""
	if len(args) > 0 {
		blockRef = args[0]
	}
	fullORef, metaData, err := getTermBlockMeta(blockRef)
	if err != nil {
		return err
	}

	status, err := wshclient.BlockControllerStatusCommand(RpcClient, fullORef.OID, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("error getting block status: %w", err)
	}
	if status == nil {
		return fmt.Errorf("block %s has no running controller", fullORef.OID)
	}

	processState := mapProcessState(status.ShellProcStatus)
	exitCode := status.ShellProcExitCode
	connection := status.ShellProcConnName
	if connection == "" {
		connection = metaData.GetString(waveobj.MetaKey_Connection, "")
	}
	if connection == "" {
		connection = "local"
	}

	// Local connections are always connected; only query the connection status
	// for genuinely remote connections.
	connStatus := "connected"
	if isNonLocalConnName(connection) {
		connStatuses, err := wshclient.ConnStatusCommand(RpcClient, nil)
		if err != nil {
			return fmt.Errorf("error getting connection status: %w", err)
		}
		connStatus = lookupConnStatus(connStatuses, connection)
	}

	if blockStatusJSON {
		outBytes, err := json.MarshalIndent(blockStatusJSONOutput{
			ProcessState: processState,
			ExitCode:     exitCode,
			Connection:   connection,
			ConnStatus:   connStatus,
		}, "", "  ")
		if err != nil {
			return fmt.Errorf("marshaling JSON output: %w", err)
		}
		WriteStdout("%s\n", string(outBytes))
		return nil
	}

	WriteStdout("process state: %s\n", processState)
	WriteStdout("exit code: %d\n", exitCode)
	WriteStdout("connection: %s\n", connection)
	WriteStdout("conn status: %s\n", connStatus)
	return nil
}

// blockNewOptions holds the parsed options for creating a new block. It is
// shared between `block new` and `block split` (which is thin sugar over
// `block new --split`).
type blockNewOptions struct {
	viewType   string
	connection string
	cmd        string
	magnified  bool
	split      string
	relativeTo string
	tabRef     string
}

// blockNewJSONOutput is the structured output shape for `block new` and
// `block split --json`. Geometry is not yet reported (Phase 3); for now only
// the block id is returned.
type blockNewJSONOutput struct {
	BlockId string `json:"blockid"`
}

func blockNewRun(cmd *cobra.Command, args []string) error {
	oref, err := createBlockNew(blockNewOptions{
		viewType:   blockNewView,
		connection: blockNewConnection,
		cmd:        blockNewCmdStr,
		magnified:  blockNewMagnified,
		split:      blockNewSplit,
		relativeTo: blockNewRelativeTo,
		tabRef:     blockNewTab,
	})
	if err != nil {
		return err
	}
	return writeBlockNewOutput(oref, blockNewJSON)
}

func blockSplitRun(cmd *cobra.Command, args []string) error {
	blockRef := args[0]
	direction := blockSplitDirection
	if direction == "" {
		return fmt.Errorf("--direction is required (one of: left, right, above, below)")
	}
	if _, err := directionToTargetAction(direction); err != nil {
		return err
	}
	oref, err := createBlockNew(blockNewOptions{
		viewType:   "term",
		split:      direction,
		relativeTo: blockRef,
	})
	if err != nil {
		return err
	}
	return writeBlockNewOutput(oref, blockSplitJSON)
}

func blockRenameRun(cmd *cobra.Command, args []string) error {
	blockRef, name, err := validateRenameArgs(args)
	if err != nil {
		return err
	}
	fullORef, err := resolveBlockArgWithOverride(blockRef)
	if err != nil {
		return err
	}
	err = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: *fullORef,
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_FrameTitle: name,
		},
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("setting block title: %w", err)
	}
	WriteStdout("renamed block %s to %q\n", fullORef.OID, name)
	return nil
}

// createBlockNew builds and submits a CommandCreateBlockData for the given
// options, returning the created block ORef.
func createBlockNew(opts blockNewOptions) (waveobj.ORef, error) {
	if err := validateSplitPair(opts.split, opts.relativeTo); err != nil {
		return waveobj.ORef{}, err
	}

	var targetBlockId, targetAction string
	if opts.split != "" {
		targetOref, err := resolveBlockArgWithOverride(opts.relativeTo)
		if err != nil {
			return waveobj.ORef{}, err
		}
		targetBlockId = targetOref.OID
		targetAction, err = directionToTargetAction(opts.split)
		if err != nil {
			return waveobj.ORef{}, err
		}
	}

	tabId, err := resolveTabIdArg(opts.tabRef)
	if err != nil {
		return waveobj.ORef{}, err
	}

	cwd, err := os.Getwd()
	if err != nil {
		return waveobj.ORef{}, fmt.Errorf("getting current directory: %w", err)
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return waveobj.ORef{}, fmt.Errorf("getting absolute path: %w", err)
	}

	connName := opts.connection
	if connName == "" {
		connName = RpcContext.Conn
	}

	meta := buildBlockNewMeta(opts.viewType, opts.cmd, cwd, connName)
	blockDef := &waveobj.BlockDef{Meta: meta}
	if opts.cmd != "" {
		blockDef.Files = map[string]*waveobj.FileDef{
			wavebase.BlockFile_Env: {
				Content: buildEnvContent(os.Environ()),
			},
		}
	}

	createData := wshrpc.CommandCreateBlockData{
		TabId:         tabId,
		BlockDef:      blockDef,
		Magnified:     opts.magnified,
		Focused:       true,
		TargetBlockId: targetBlockId,
		TargetAction:  targetAction,
	}

	oref, err := wshclient.CreateBlockCommand(RpcClient, createData, nil)
	if err != nil {
		return waveobj.ORef{}, fmt.Errorf("creating new block: %w", err)
	}
	return oref, nil
}

// writeBlockNewOutput prints the created block ref, or a JSON object when
// jsonOut is set.
func writeBlockNewOutput(oref waveobj.ORef, jsonOut bool) error {
	if jsonOut {
		outBytes, err := json.Marshal(blockNewJSONOutput{BlockId: oref.OID})
		if err != nil {
			return fmt.Errorf("marshaling JSON output: %w", err)
		}
		WriteStdout("%s\n", string(outBytes))
		return nil
	}
	WriteStdout("block created: %s\n", oref)
	return nil
}

// directionToTargetAction maps a user-facing split direction to the
// CommandCreateBlockData TargetAction used by the backend.
func directionToTargetAction(direction string) (string, error) {
	switch direction {
	case "left":
		return "splitleft", nil
	case "right":
		return "splitright", nil
	case "above":
		return "splitup", nil
	case "below":
		return "splitdown", nil
	default:
		return "", fmt.Errorf("invalid direction %q (must be one of: left, right, above, below)", direction)
	}
}

// validateSplitPair enforces that --split and --relative-to are used together.
func validateSplitPair(split, relativeTo string) error {
	if split != "" && relativeTo == "" {
		return fmt.Errorf("--split requires --relative-to")
	}
	if split == "" && relativeTo != "" {
		return fmt.Errorf("--relative-to requires --split")
	}
	return nil
}

// buildBlockNewMeta builds the block metadata for `wsh block new`. When cmd is
// empty and the view is a terminal, it creates a plain terminal (controller
// "shell"); when cmd is set it creates a persistent command block (controller
// "cmd", runs on start, no close-on-exit).
func buildBlockNewMeta(viewType, cmd, cwd, connection string) waveobj.MetaMapType {
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View: viewType,
	}
	if cmd != "" {
		meta[waveobj.MetaKey_Controller] = "cmd"
		meta[waveobj.MetaKey_CmdCwd] = cwd
		meta[waveobj.MetaKey_CmdClearOnStart] = true
		meta[waveobj.MetaKey_Cmd] = cmd
		meta[waveobj.MetaKey_CmdArgs] = []string{}
		meta[waveobj.MetaKey_CmdShell] = true
		meta[waveobj.MetaKey_CmdRunOnStart] = true
	} else if viewType == "term" {
		meta[waveobj.MetaKey_Controller] = "shell"
		meta[waveobj.MetaKey_CmdCwd] = cwd
	}
	if connection != "" {
		meta[waveobj.MetaKey_Connection] = connection
	}
	return meta
}

// buildEnvContent converts the given environment strings (os.Environ format,
// "KEY=VALUE") into the null-terminated block env file format.
func buildEnvContent(environ []string) string {
	envMap := make(map[string]string)
	for _, envStr := range environ {
		env := strings.SplitN(envStr, "=", 2)
		if len(env) == 2 {
			envMap[env[0]] = env[1]
		}
	}
	return envutil.MapToEnv(envMap)
}

// validateRenameArgs enforces the two-positional-arg requirement for rename
// and that the new name is non-empty.
func validateRenameArgs(args []string) (blockRef, name string, err error) {
	if len(args) != 2 {
		return "", "", fmt.Errorf("rename requires exactly 2 arguments: <block_ref> and <name>")
	}
	if args[1] == "" {
		return "", "", fmt.Errorf("block name must not be empty")
	}
	return args[0], args[1], nil
}

// resolveTabIdArg resolves a --tab argument to a tab id. An empty ref returns
// the current tab from the environment. A full tab ORef is validated and its
// id returned; a bare uuid is passed through as a tab id; any other ref
// (e.g. tab:N) is resolved via resolveSimpleId and must resolve to a tab.
func resolveTabIdArg(tabRef string) (string, error) {
	if tabRef == "" {
		tabId := getTabIdFromEnv()
		if tabId == "" {
			return "", fmt.Errorf("no WAVETERM_TABID env var set (use --tab)")
		}
		return tabId, nil
	}
	if isFullORef(tabRef) {
		oref, err := waveobj.ParseORef(tabRef)
		if err != nil {
			return "", err
		}
		if oref.OType != waveobj.OType_Tab {
			return "", fmt.Errorf("--tab %q is a %s, expected a tab", tabRef, oref.OType)
		}
		return oref.OID, nil
	}
	if _, err := uuid.Parse(tabRef); err == nil {
		return tabRef, nil
	}
	oref, err := resolveSimpleId(tabRef)
	if err != nil {
		return "", fmt.Errorf("resolving tab ref %q: %w", tabRef, err)
	}
	if oref.OType != waveobj.OType_Tab {
		return "", fmt.Errorf("--tab %q resolved to a %s, expected a tab", tabRef, oref.OType)
	}
	return oref.OID, nil
}
