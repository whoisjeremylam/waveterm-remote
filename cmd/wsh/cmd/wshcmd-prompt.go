// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var promptOptions string

var promptCmd = &cobra.Command{
	Use:   "prompt <question> [--options \"a,b,c\"]",
	Short: "ask the user a question in a modal and wait for the answer",
	Long: `Ask the user a question via a UI modal and block until answered, printing
the answer to stdout. Works from hidden/background blocks.

Without --options the modal shows a free-text input and returns the typed answer.
With --options the modal shows one button per option and returns the clicked one.`,
	Example: "  wsh prompt \"Deploy to production?\" --options \"yes,no\"\n  wsh prompt \"What is your name?\"",
	Args:    cobra.MinimumNArgs(1),
	RunE:    promptRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	promptCmd.Flags().StringVar(&promptOptions, "options", "", "comma-separated list of options")
	rootCmd.AddCommand(promptCmd)
}

// parseOptionsFlag splits a comma-separated options string, trimming whitespace
// and dropping nothing (empty options are an error). An empty/whitespace-only
// flag yields nil (no options, i.e. free-text prompt).
func parseOptionsFlag(optionsFlag string) ([]string, error) {
	if strings.TrimSpace(optionsFlag) == "" {
		return nil, nil
	}
	parts := strings.Split(optionsFlag, ",")
	options := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			return nil, fmt.Errorf("invalid --options value %q: empty option", optionsFlag)
		}
		options = append(options, trimmed)
	}
	return options, nil
}

func promptRun(cmd *cobra.Command, args []string) (rtnErr error) {
	question := strings.Join(args, " ")
	options, err := parseOptionsFlag(promptOptions)
	if err != nil {
		return err
	}
	data := wshrpc.CommandPromptData{
		Question: question,
		Options:  options,
	}
	// The user may take a while to answer; the server-side prompt has its own 60s
	// timeout, so allow the RPC to block up to 120s (RpcOpts.Timeout is in ms and
	// 0 falls back to the 5s default, which is far too short for a prompt).
	answer, err := wshclient.PromptCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 120000})
	if err != nil {
		return fmt.Errorf("prompt: %w", err)
	}
	WriteStdout("%s\n", answer)
	return nil
}
