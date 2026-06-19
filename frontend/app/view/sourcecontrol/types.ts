// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type SelectedFile = {
    path: string;
    staged: boolean;
};

export type FileTreeNode = {
    id: string;
    name: string;
    path: string;
    status: GitFileChange;
    isDirectory: boolean;
    children?: FileTreeNode[];
};
