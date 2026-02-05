package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

type AppInfo struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	GitHubURL string `json:"githubUrl"`
}

//go:embed appinfo.json
var appInfoJSON []byte

var (
	appInfoOnce sync.Once
	appInfo     AppInfo
	appInfoErr  error
)

func loadAppInfo() (AppInfo, error) {
	appInfoOnce.Do(func() {
		if len(appInfoJSON) == 0 {
			appInfoErr = fmt.Errorf("appinfo.json is missing")
			return
		}

		if err := json.Unmarshal(appInfoJSON, &appInfo); err != nil {
			appInfoErr = fmt.Errorf("parse appinfo.json: %w", err)
			return
		}

		if appInfo.Name == "" {
			appInfo.Name = "Walioss"
		}
		if appInfo.Version == "" {
			appInfo.Version = "0.0.0"
		}
	})

	return appInfo, appInfoErr
}

func (a *App) GetAppInfo() (AppInfo, error) {
	return loadAppInfo()
}

