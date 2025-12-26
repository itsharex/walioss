package main

// ObjectInfo represents an OSS object (file or folder)
type ObjectInfo struct {
	Name         string `json:"name"`
	Path         string `json:"path"` // Full path including bucket
	Size         int64  `json:"size"`
	Type         string `json:"type"` // "File" or "Folder"
	LastModified string `json:"lastModified"`
	StorageClass string `json:"storageClass"`
}
