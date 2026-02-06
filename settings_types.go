package main

// AppSettings holds application-wide settings
type AppSettings struct {
	OssutilPath        string `json:"ossutilPath"`
	WorkDir            string `json:"workDir"`
	DefaultRegion      string `json:"defaultRegion"`
	DefaultEndpoint    string `json:"defaultEndpoint"`
	Theme              string `json:"theme"` // "light" or "dark"
	MaxTransferThreads int    `json:"maxTransferThreads"`
	NewTabNameRule     string `json:"newTabNameRule"` // "folder" | "newTab"
}
