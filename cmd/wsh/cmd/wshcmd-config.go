// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "get and set Wave configuration values",
}

var configGetCmd = &cobra.Command{
	Use:     "get <key>",
	Short:   "get a config value",
	Args:    cobra.ExactArgs(1),
	RunE:    configGetRun,
	PreRunE: preRunSetupRpcClient,
}

var configSetCmd = &cobra.Command{
	Use:     "set <key> <value>",
	Short:   "set a config value",
	Args:    cobra.ExactArgs(2),
	RunE:    configSetRun,
	PreRunE: preRunSetupRpcClient,
}

var configListCmd = &cobra.Command{
	Use:   "list",
	Short: "list config keys and their metadata",
	Long: `List config keys with their type, description, and whether a change requires
a UI reload. The JSON key for reload-required is "reloadrequired". Currently
enumerates top-level settings (settings.json) only; connection, preset, and
widget enumeration is deferred.`,
	Args: cobra.NoArgs,
	RunE: configListRun,
}

var (
	configGetJson       bool
	configGetConnection string
	configListJson      bool
)

func init() {
	configGetCmd.Flags().BoolVar(&configGetJson, "json", false, "output the value as JSON")
	configGetCmd.Flags().StringVar(&configGetConnection, "connection", "", "read config from the named connection")
	configListCmd.Flags().BoolVar(&configListJson, "json", false, "output the list as JSON")
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configListCmd)
	rootCmd.AddCommand(configCmd)
}

// configField describes a single config key's reflection info.
type configField struct {
	Key            string       `json:"key"`
	GoType         reflect.Type `json:"-"`
	Index          int          `json:"index"`
	Type           string       `json:"type"`
	Description    string       `json:"description"`
	ReloadRequired bool         `json:"reloadrequired"`
}

// buildConfigFieldIndex builds a map from config key to the field's reflection
// info for the given struct type. It skips fields with no json tag or a json
// tag of "-".
func buildConfigFieldIndex(t reflect.Type) map[string]configField {
	result := make(map[string]configField)
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		jsonTag := utilfn.GetJsonTag(field)
		if jsonTag == "" || jsonTag == "-" {
			continue
		}
		result[jsonTag] = configField{
			Key:            jsonTag,
			GoType:         field.Type,
			Index:          i,
			Type:           configTypeName(field.Type),
			Description:    configDescription(field),
			ReloadRequired: configReloadRequired(field),
		}
	}
	return result
}

// configTypeName maps a config field's Go type to a simple type name used in
// `wsh config list` output. Pointer fields are dereferenced first.
func configTypeName(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "integer"
	case reflect.Slice, reflect.Array:
		return "array"
	case reflect.Map:
		return "object"
	default:
		return t.String()
	}
}

// splitConfigTag splits a struct tag value on unescaped commas, mirroring the
// invopop/jsonschema tag parsing so "description=..." can be extracted even
// when combined with "enum=..." tokens (e.g. "enum=off,enum=on,description=Foo").
func splitConfigTag(tag string) []string {
	if tag == "" {
		return nil
	}
	separated := strings.Split(tag, ",")
	ret := []string{separated[0]}
	for _, nextTag := range separated[1:] {
		i := len(ret) - 1
		if len(ret[i]) == 0 {
			ret = append(ret, nextTag)
			continue
		}
		if ret[i][len(ret[i])-1] == '\\' {
			ret[i] = ret[i][:len(ret[i])-1] + "," + nextTag
		} else {
			ret = append(ret, nextTag)
		}
	}
	return ret
}

// configDescription extracts the "description=" value from the jsonschema
// struct tag, if present. Returns "" when absent.
func configDescription(field reflect.StructField) string {
	for _, token := range splitConfigTag(field.Tag.Get("jsonschema")) {
		if strings.HasPrefix(token, "description=") {
			return strings.TrimPrefix(token, "description=")
		}
	}
	return ""
}

// configReloadRequired reports whether a field carries reload:"required".
func configReloadRequired(field reflect.StructField) bool {
	return strings.Contains(field.Tag.Get("reload"), "required")
}

// readConfigFieldValue reads a field's value from a reflect.Value of the struct.
// For pointer fields, a nil pointer is returned as nil (unset); non-nil pointers
// are dereferenced to their underlying value.
func readConfigFieldValue(structVal reflect.Value, field configField) any {
	fieldVal := structVal.Field(field.Index)
	if fieldVal.Kind() == reflect.Pointer {
		if fieldVal.IsNil() {
			return nil
		}
		return fieldVal.Elem().Interface()
	}
	return fieldVal.Interface()
}

// parseConfigValue parses a string into the declared Go type of a config field.
// Pointer fields are parsed as their base type; the returned value is the
// non-pointer base value (the server wraps it back into a pointer as needed).
func parseConfigValue(setVal string, goType reflect.Type) (any, error) {
	isPtr := goType.Kind() == reflect.Pointer
	baseType := goType
	if isPtr {
		baseType = goType.Elem()
	}
	switch baseType.Kind() {
	case reflect.String:
		return setVal, nil
	case reflect.Bool:
		bval, err := strconv.ParseBool(setVal)
		if err != nil {
			return nil, fmt.Errorf("invalid bool value %q", setVal)
		}
		return bval, nil
	case reflect.Float32, reflect.Float64:
		fval, err := strconv.ParseFloat(setVal, baseType.Bits())
		if err != nil {
			return nil, fmt.Errorf("invalid float value %q", setVal)
		}
		if baseType.Kind() == reflect.Float32 {
			return float32(fval), nil
		}
		return fval, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		ival, err := strconv.ParseInt(setVal, 0, baseType.Bits())
		if err != nil {
			return nil, fmt.Errorf("invalid int value %q", setVal)
		}
		switch baseType.Kind() {
		case reflect.Int:
			return int(ival), nil
		case reflect.Int8:
			return int8(ival), nil
		case reflect.Int16:
			return int16(ival), nil
		case reflect.Int32:
			return int32(ival), nil
		default:
			return ival, nil
		}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		uval, err := strconv.ParseUint(setVal, 0, baseType.Bits())
		if err != nil {
			return nil, fmt.Errorf("invalid uint value %q", setVal)
		}
		switch baseType.Kind() {
		case reflect.Uint:
			return uint(uval), nil
		case reflect.Uint8:
			return uint8(uval), nil
		case reflect.Uint16:
			return uint16(uval), nil
		case reflect.Uint32:
			return uint32(uval), nil
		default:
			return uval, nil
		}
	case reflect.Slice:
		// Slices (e.g. []string) are parsed from a JSON array value.
		dst := reflect.New(baseType)
		if err := json.Unmarshal([]byte(setVal), dst.Interface()); err != nil {
			return nil, fmt.Errorf("invalid %s value %q: %v", baseType, setVal, err)
		}
		return dst.Elem().Interface(), nil
	case reflect.Map:
		// Maps (e.g. map[string]string) are parsed from a JSON object value.
		dst := reflect.New(baseType)
		if err := json.Unmarshal([]byte(setVal), dst.Interface()); err != nil {
			return nil, fmt.Errorf("invalid %s value %q: %v", baseType, setVal, err)
		}
		return dst.Elem().Interface(), nil
	default:
		return nil, fmt.Errorf("unsupported type %s", goType)
	}
}

// formatConfigValue renders a config value for human-readable output.
// Strings are quoted so the type is visible (e.g. term:fontfamily = "Mono").
func formatConfigValue(value any) string {
	if value == nil {
		return "null"
	}
	if s, ok := value.(string); ok {
		return strconv.Quote(s)
	}
	return fmt.Sprintf("%v", value)
}

func configGetRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
	}()

	key := args[0]
	fullConfig, err := wshclient.GetFullConfigCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("getting config: %w", err)
	}

	var structVal reflect.Value
	var field configField
	var ok bool
	if configGetConnection != "" {
		conn, exists := fullConfig.Connections[configGetConnection]
		if !exists {
			return fmt.Errorf("unknown connection %q", configGetConnection)
		}
		fieldIdx := buildConfigFieldIndex(reflect.TypeOf(conn))
		field, ok = fieldIdx[key]
		if !ok {
			return fmt.Errorf("unknown config key %q", key)
		}
		structVal = reflect.ValueOf(conn)
	} else {
		fieldIdx := buildConfigFieldIndex(reflect.TypeOf(fullConfig.Settings))
		field, ok = fieldIdx[key]
		if !ok {
			return fmt.Errorf("unknown config key %q", key)
		}
		structVal = reflect.ValueOf(fullConfig.Settings)
	}

	value := readConfigFieldValue(structVal, field)
	if configGetJson {
		barr, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("marshaling value: %w", err)
		}
		WriteStdout("%s\n", string(barr))
		return nil
	}
	WriteStdout("%s = %s\n", key, formatConfigValue(value))
	return nil
}

// configListEntry is the JSON shape for a single `wsh config list --json` row.
type configListEntry struct {
	Key            string `json:"key"`
	Type           string `json:"type"`
	Description    string `json:"description"`
	ReloadRequired bool   `json:"reloadrequired"`
}

func configListRun(cmd *cobra.Command, args []string) error {
	idx := buildConfigFieldIndex(reflect.TypeOf(wconfig.SettingsType{}))
	keys := make([]string, 0, len(idx))
	for key := range idx {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	if configListJson {
		entries := make([]configListEntry, 0, len(keys))
		for _, key := range keys {
			field := idx[key]
			entries = append(entries, configListEntry{
				Key:            field.Key,
				Type:           field.Type,
				Description:    field.Description,
				ReloadRequired: field.ReloadRequired,
			})
		}
		barr, err := json.MarshalIndent(entries, "", "  ")
		if err != nil {
			return fmt.Errorf("marshaling config list: %w", err)
		}
		WriteStdout("%s\n", string(barr))
		return nil
	}

	WriteStdout("KEY\tTYPE\tDESCRIPTION\tRELOAD\n")
	for _, key := range keys {
		field := idx[key]
		WriteStdout("%s\t%s\t%s\t%v\n", field.Key, field.Type, field.Description, field.ReloadRequired)
	}
	return nil
}

func configSetRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
	}()

	key := args[0]
	setVal := args[1]

	// Connection-scoped set is deferred (see Phase 4 note); only top-level
	// SettingsType keys are settable here.
	fieldIdx := buildConfigFieldIndex(reflect.TypeOf(wconfig.SettingsType{}))
	field, ok := fieldIdx[key]
	if !ok {
		return fmt.Errorf("unknown config key %q", key)
	}
	parsed, err := parseConfigValue(setVal, field.GoType)
	if err != nil {
		return fmt.Errorf("parsing value for %q: %w", key, err)
	}
	err = wshclient.SetConfigCommand(RpcClient, wshrpc.MetaSettingsType{MetaMapType: waveobj.MetaMapType{key: parsed}}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("setting config: %w", err)
	}
	WriteStdout("config set\n")
	return nil
}
