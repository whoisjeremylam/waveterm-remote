// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func TestBuildConfigFieldIndexSettings(t *testing.T) {
	idx := buildConfigFieldIndex(reflect.TypeOf(wconfig.SettingsType{}))

	tests := []struct {
		name      string
		key       string
		wantFound bool
		wantKind  reflect.Kind
		wantPtr   bool
	}{
		{name: "term fontfamily is value string", key: "term:fontfamily", wantFound: true, wantKind: reflect.String, wantPtr: false},
		{name: "term fontsize is value float64", key: "term:fontsize", wantFound: true, wantKind: reflect.Float64, wantPtr: false},
		{name: "app tabbar is value string", key: "app:tabbar", wantFound: true, wantKind: reflect.String, wantPtr: false},
		{name: "term scrollback is pointer int64", key: "term:scrollback", wantFound: true, wantKind: reflect.Int64, wantPtr: true},
		{name: "term copyonselect is pointer bool", key: "term:copyonselect", wantFound: true, wantKind: reflect.Bool, wantPtr: true},
		{name: "term localshellopts is value slice", key: "term:localshellopts", wantFound: true, wantKind: reflect.Slice, wantPtr: false},
		{name: "window maxtabcachesize is value int", key: "window:maxtabcachesize", wantFound: true, wantKind: reflect.Int, wantPtr: false},
		{name: "unknown key not found", key: "nonexistent:key", wantFound: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			field, ok := idx[tt.key]
			if ok != tt.wantFound {
				t.Fatalf("buildConfigFieldIndex()[%q] found=%v, want %v", tt.key, ok, tt.wantFound)
			}
			if !tt.wantFound {
				return
			}
			gotKind := field.GoType.Kind()
			gotPtr := field.GoType.Kind() == reflect.Pointer
			if gotKind != tt.wantKind && !(gotPtr && field.GoType.Elem().Kind() == tt.wantKind) {
				t.Errorf("buildConfigFieldIndex()[%q] kind = %v, want %v", tt.key, gotKind, tt.wantKind)
			}
			if gotPtr != tt.wantPtr {
				t.Errorf("buildConfigFieldIndex()[%q] ptr = %v, want %v", tt.key, gotPtr, tt.wantPtr)
			}
		})
	}
}

func TestBuildConfigFieldIndexConnKeywords(t *testing.T) {
	idx := buildConfigFieldIndex(reflect.TypeOf(wconfig.ConnKeywords{}))

	tests := []struct {
		name     string
		key      string
		wantKind reflect.Kind
		wantPtr  bool
	}{
		{name: "ssh user is pointer string", key: "ssh:user", wantKind: reflect.String, wantPtr: true},
		{name: "term fontfamily is value string", key: "term:fontfamily", wantKind: reflect.String, wantPtr: false},
		{name: "cmd env is value map", key: "cmd:env", wantKind: reflect.Map, wantPtr: false},
		{name: "ssh identityfile is value slice", key: "ssh:identityfile", wantKind: reflect.Slice, wantPtr: false},
		{name: "display order is value float32", key: "display:order", wantKind: reflect.Float32, wantPtr: false},
		{name: "conn wshenabled is pointer bool", key: "conn:wshenabled", wantKind: reflect.Bool, wantPtr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			field, ok := idx[tt.key]
			if !ok {
				t.Fatalf("buildConfigFieldIndex()[%q] not found", tt.key)
			}
			gotPtr := field.GoType.Kind() == reflect.Pointer
			gotKind := field.GoType.Kind()
			if gotPtr {
				gotKind = field.GoType.Elem().Kind()
			}
			if gotKind != tt.wantKind {
				t.Errorf("buildConfigFieldIndex()[%q] kind = %v, want %v", tt.key, gotKind, tt.wantKind)
			}
			if gotPtr != tt.wantPtr {
				t.Errorf("buildConfigFieldIndex()[%q] ptr = %v, want %v", tt.key, gotPtr, tt.wantPtr)
			}
		})
	}
}

func TestParseConfigValue(t *testing.T) {
	tests := []struct {
		name    string
		goType  reflect.Type
		input   string
		want    any
		wantErr bool
	}{
		{name: "string", goType: reflect.TypeOf(""), input: "hello", want: "hello"},
		{name: "string keeps numeric text", goType: reflect.TypeOf(""), input: "42", want: "42"},
		{name: "bool true", goType: reflect.TypeOf(true), input: "true", want: true},
		{name: "bool false", goType: reflect.TypeOf(true), input: "false", want: false},
		{name: "bool one", goType: reflect.TypeOf(true), input: "1", want: true},
		{name: "bool zero", goType: reflect.TypeOf(true), input: "0", want: false},
		{name: "bool invalid", goType: reflect.TypeOf(true), input: "yes", wantErr: true},
		{name: "float64", goType: reflect.TypeOf(float64(0)), input: "3.14", want: float64(3.14)},
		{name: "float64 int text", goType: reflect.TypeOf(float64(0)), input: "14", want: float64(14)},
		{name: "float64 invalid", goType: reflect.TypeOf(float64(0)), input: "notanumber", wantErr: true},
		{name: "int64", goType: reflect.TypeOf(int64(0)), input: "42", want: int64(42)},
		{name: "int64 hex", goType: reflect.TypeOf(int64(0)), input: "0x10", want: int64(16)},
		{name: "int64 invalid", goType: reflect.TypeOf(int64(0)), input: "notanumber", wantErr: true},
		{name: "int", goType: reflect.TypeOf(int(0)), input: "42", want: int(42)},
		{name: "string slice", goType: reflect.TypeOf([]string{}), input: `["a","b"]`, want: []string{"a", "b"}},
		{name: "string slice invalid", goType: reflect.TypeOf([]string{}), input: `not-json`, wantErr: true},
		{name: "string map", goType: reflect.TypeOf(map[string]string{}), input: `{"a":"b"}`, want: map[string]string{"a": "b"}},
		{name: "string map invalid", goType: reflect.TypeOf(map[string]string{}), input: `[1,2]`, wantErr: true},
		{name: "pointer bool", goType: reflect.TypeOf((*bool)(nil)), input: "true", want: true},
		{name: "pointer int64", goType: reflect.TypeOf((*int64)(nil)), input: "42", want: int64(42)},
		{name: "pointer float64", goType: reflect.TypeOf((*float64)(nil)), input: "1.5", want: float64(1.5)},
		{name: "unsupported struct", goType: reflect.TypeOf(struct{}{}), input: "x", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseConfigValue(tt.input, tt.goType)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseConfigValue() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseConfigValue() = %v (%T), want %v (%T)", got, got, tt.want, tt.want)
			}
		})
	}
}

func TestReadConfigFieldValue(t *testing.T) {
	idx := buildConfigFieldIndex(reflect.TypeOf(wconfig.SettingsType{}))

	settings := wconfig.SettingsType{
		TermFontFamily: "JetBrains Mono",
		TermFontSize:   14,
	}
	scrollback := int64(100)
	settings.TermScrollback = &scrollback

	tests := []struct {
		name string
		key  string
		want any
	}{
		{name: "string value", key: "term:fontfamily", want: "JetBrains Mono"},
		{name: "float64 value", key: "term:fontsize", want: float64(14)},
		{name: "non-nil pointer dereferenced", key: "term:scrollback", want: int64(100)},
		{name: "nil pointer returns nil", key: "term:copyonselect", want: nil},
	}

	structVal := reflect.ValueOf(settings)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			field := idx[tt.key]
			got := readConfigFieldValue(structVal, field)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("readConfigFieldValue() = %v (%T), want %v (%T)", got, got, tt.want, tt.want)
			}
		})
	}
}

func TestFormatConfigValue(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  string
	}{
		{name: "string quoted", input: "JetBrains Mono", want: `"JetBrains Mono"`},
		{name: "int", input: int64(14), want: "14"},
		{name: "bool", input: true, want: "true"},
		{name: "nil", input: nil, want: "null"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatConfigValue(tt.input)
			if got != tt.want {
				t.Errorf("formatConfigValue() = %q, want %q", got, tt.want)
			}
		})
	}
}

// configTagTestStruct exercises the tag parsing helpers with synthetic tags.
type configTagTestStruct struct {
	Simple       string `json:"simple" jsonschema:"description=hello"`
	WithEnum     string `json:"withenum" jsonschema:"enum=off,enum=on,description=with enum"`
	NoDesc       string `json:"nodesc"`
	EscapedComma string `json:"escapedcomma" jsonschema:"description=a\\, b"`
	ReloadReq    string `json:"reloadreq" reload:"required"`
	ReloadEmpty  string `json:"reloadempty" reload:""`
	ReloadOther  string `json:"reloadother" reload:"optional"`
}

func TestBuildConfigFieldIndexMetadata(t *testing.T) {
	idx := buildConfigFieldIndex(reflect.TypeOf(wconfig.SettingsType{}))

	tests := []struct {
		name       string
		key        string
		wantType   string
		wantDesc   string
		wantReload bool
	}{
		{name: "term fontfamily is string", key: "term:fontfamily", wantType: "string", wantDesc: "Terminal font family"},
		{name: "term fontsize is number", key: "term:fontsize", wantType: "number", wantDesc: "Terminal font size"},
		{name: "app confirmquit is boolean and reload required", key: "app:confirmquit", wantType: "boolean", wantDesc: "Prompt for confirmation before quitting", wantReload: true},
		{name: "app tabbar reload required", key: "app:tabbar", wantType: "string", wantDesc: "Tab bar placement", wantReload: true},
		{name: "term scrollback is integer", key: "term:scrollback", wantType: "integer", wantDesc: "Terminal scrollback buffer size (lines)"},
		{name: "term localshellopts is array with no description", key: "term:localshellopts", wantType: "array", wantDesc: ""},
		{name: "app globalhotkey reload required", key: "app:globalhotkey", wantType: "string", wantDesc: "Global hotkey to summon Wave", wantReload: true},
		{name: "window nativetitlebar reload required", key: "window:nativetitlebar", wantType: "boolean", wantDesc: "", wantReload: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			field, ok := idx[tt.key]
			if !ok {
				t.Fatalf("buildConfigFieldIndex()[%q] not found", tt.key)
			}
			if field.Type != tt.wantType {
				t.Errorf("buildConfigFieldIndex()[%q] type = %q, want %q", tt.key, field.Type, tt.wantType)
			}
			if field.Description != tt.wantDesc {
				t.Errorf("buildConfigFieldIndex()[%q] description = %q, want %q", tt.key, field.Description, tt.wantDesc)
			}
			if field.ReloadRequired != tt.wantReload {
				t.Errorf("buildConfigFieldIndex()[%q] reloadrequired = %v, want %v", tt.key, field.ReloadRequired, tt.wantReload)
			}
		})
	}
}

func TestConfigTypeName(t *testing.T) {
	tests := []struct {
		name string
		t    reflect.Type
		want string
	}{
		{name: "string", t: reflect.TypeOf(""), want: "string"},
		{name: "bool", t: reflect.TypeOf(true), want: "boolean"},
		{name: "float64", t: reflect.TypeOf(float64(0)), want: "number"},
		{name: "float32", t: reflect.TypeOf(float32(0)), want: "number"},
		{name: "int", t: reflect.TypeOf(int(0)), want: "integer"},
		{name: "int64", t: reflect.TypeOf(int64(0)), want: "integer"},
		{name: "uint", t: reflect.TypeOf(uint(0)), want: "integer"},
		{name: "pointer bool", t: reflect.TypeOf((*bool)(nil)), want: "boolean"},
		{name: "pointer int64", t: reflect.TypeOf((*int64)(nil)), want: "integer"},
		{name: "slice", t: reflect.TypeOf([]string{}), want: "array"},
		{name: "map", t: reflect.TypeOf(map[string]string{}), want: "object"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := configTypeName(tt.t); got != tt.want {
				t.Errorf("configTypeName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestConfigDescription(t *testing.T) {
	tp := reflect.TypeOf(configTagTestStruct{})
	tests := []struct {
		name      string
		fieldName string
		want      string
	}{
		{name: "simple description", fieldName: "Simple", want: "hello"},
		{name: "description combined with enum", fieldName: "WithEnum", want: "with enum"},
		{name: "no description", fieldName: "NoDesc", want: ""},
		{name: "escaped comma description", fieldName: "EscapedComma", want: "a, b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, ok := tp.FieldByName(tt.fieldName)
			if !ok {
				t.Fatalf("field %q not found", tt.fieldName)
			}
			if got := configDescription(f); got != tt.want {
				t.Errorf("configDescription() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestConfigReloadRequired(t *testing.T) {
	tp := reflect.TypeOf(configTagTestStruct{})
	tests := []struct {
		name      string
		fieldName string
		want      bool
	}{
		{name: "required tag", fieldName: "ReloadReq", want: true},
		{name: "empty tag", fieldName: "ReloadEmpty", want: false},
		{name: "non-required value", fieldName: "ReloadOther", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, ok := tp.FieldByName(tt.fieldName)
			if !ok {
				t.Fatalf("field %q not found", tt.fieldName)
			}
			if got := configReloadRequired(f); got != tt.want {
				t.Errorf("configReloadRequired() = %v, want %v", got, tt.want)
			}
		})
	}
}
