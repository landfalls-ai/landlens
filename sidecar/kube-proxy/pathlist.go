package main

import "path/filepath"

// filepathSplit splits a KUBECONFIG-style list with the OS separator.
func filepathSplit(s string) []string { return filepath.SplitList(s) }
