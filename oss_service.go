package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	oss "github.com/aliyun/aliyun-oss-go-sdk/oss"
)

func normalizeRegion(region string) string {
	region = strings.TrimSpace(region)
	region = strings.TrimPrefix(region, "oss-")
	return region
}

func normalizeEndpoint(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}

	// If user pasted a full URL, keep only host.
	if strings.Contains(endpoint, "://") {
		if u, err := url.Parse(endpoint); err == nil {
			if u.Host != "" {
				endpoint = u.Host
			}
		}
	}

	// Strip path/query fragments if still present.
	endpoint = strings.SplitN(endpoint, "?", 2)[0]
	endpoint = strings.SplitN(endpoint, "#", 2)[0]
	endpoint = strings.SplitN(endpoint, "/", 2)[0]
	endpoint = strings.TrimSuffix(endpoint, ".")
	return endpoint
}

func isAccessPointEndpoint(endpoint string) bool {
	endpoint = strings.ToLower(endpoint)
	return strings.Contains(endpoint, ".oss-accesspoint.")
}

func suggestServiceEndpoint(region string) string {
	region = normalizeRegion(region)
	if region == "" {
		return ""
	}
	return fmt.Sprintf("oss-%s.aliyuncs.com", region)
}

// OSSService handles OSS operations via ossutil
type OSSService struct {
	ossutilPath        string
	defaultOssutilPath string
	defaultConfigDir   string
	configDir          string
	transferSeq        uint64
	transferCtxMu      sync.RWMutex
	transferCtx        context.Context
	transferLimiterMu  sync.RWMutex
	transferLimiter    *transferLimiter
}

const (
	appStateSchemaVersion = 2
	appStateFileName      = "config.json"
	legacySettingsName    = "settings.json"
	legacyProfilesName    = "profiles.json"
	workDirRefFileName    = "workdir.json"
)

type appState struct {
	SchemaVersion int          `json:"schemaVersion"`
	Settings      AppSettings  `json:"settings"`
	Profiles      []OSSProfile `json:"profiles"`
}

type workDirRef struct {
	WorkDir string `json:"workDir"`
}

func normalizeWorkDirPath(pathValue string, fallback string) string {
	fallback = filepath.Clean(strings.TrimSpace(fallback))
	if fallback == "" {
		fallback = ".walioss"
	}

	p := strings.TrimSpace(pathValue)
	if p == "" {
		p = fallback
	}

	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
			if p == "~" {
				p = home
			} else {
				p = filepath.Join(home, strings.TrimPrefix(p, "~/"))
			}
		}
	}

	if !filepath.IsAbs(p) {
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
	}

	p = filepath.Clean(p)
	if strings.TrimSpace(p) == "" {
		return fallback
	}
	return p
}

func compactHomePath(pathValue string) string {
	p := strings.TrimSpace(pathValue)
	if p == "" {
		return p
	}
	p = filepath.Clean(p)

	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return p
	}
	home = filepath.Clean(home)

	rel, err := filepath.Rel(home, p)
	if err != nil {
		return p
	}
	rel = filepath.ToSlash(rel)

	if rel == "." {
		return "~"
	}
	if rel == ".." || strings.HasPrefix(rel, "../") {
		return p
	}
	return "~/" + rel
}

func defaultAppSettings(workDir string) AppSettings {
	workDir = normalizeWorkDirPath(workDir, workDir)
	return AppSettings{
		OssutilPath:        "",
		WorkDir:            compactHomePath(workDir),
		DefaultRegion:      "",
		DefaultEndpoint:    "",
		Theme:              "dark",
		MaxTransferThreads: 3,
		NewTabNameRule:     "folder",
	}
}

func normalizeAppSettings(settings AppSettings, fallbackWorkDir string) AppSettings {
	out := settings
	out.OssutilPath = strings.TrimSpace(out.OssutilPath)
	out.DefaultRegion = strings.TrimSpace(out.DefaultRegion)
	out.DefaultEndpoint = strings.TrimSpace(out.DefaultEndpoint)
	out.WorkDir = normalizeWorkDirPath(out.WorkDir, fallbackWorkDir)

	out.Theme = strings.TrimSpace(out.Theme)
	switch out.Theme {
	case "dark", "light":
	default:
		out.Theme = "dark"
	}

	if out.MaxTransferThreads <= 0 {
		out.MaxTransferThreads = 3
	}
	if out.MaxTransferThreads > 64 {
		out.MaxTransferThreads = 64
	}

	out.NewTabNameRule = strings.TrimSpace(out.NewTabNameRule)
	switch out.NewTabNameRule {
	case "folder", "newTab":
	default:
		out.NewTabNameRule = "folder"
	}

	return out
}

func readWorkDirRefFromDefault(defaultDir string) string {
	defaultDir = normalizeWorkDirPath(defaultDir, defaultDir)
	refPath := filepath.Join(defaultDir, workDirRefFileName)

	data, err := os.ReadFile(refPath)
	if err != nil {
		return ""
	}

	var ref workDirRef
	if err := json.Unmarshal(data, &ref); err != nil {
		return ""
	}
	return normalizeWorkDirPath(ref.WorkDir, defaultDir)
}

// NewOSSService creates a new OSSService instance
func NewOSSService() *OSSService {
	homeDir, _ := os.UserHomeDir()
	defaultConfigDir := normalizeWorkDirPath(filepath.Join(homeDir, ".walioss"), filepath.Join(homeDir, ".walioss"))
	configDir := defaultConfigDir
	if refDir := readWorkDirRefFromDefault(defaultConfigDir); refDir != "" {
		configDir = refDir
	}

	// Try to find ossutil in bin/ directory relative to executable
	ossutilPath := "ossutil" // Default to PATH lookup

	// Get executable directory
	exePath, err := os.Executable()
	if err == nil {
		exeDir := filepath.Dir(exePath)
		// Check for ossutil in bin/ subdirectory
		binPath := filepath.Join(exeDir, "bin", "ossutil")
		if _, err := os.Stat(binPath); err == nil {
			ossutilPath = binPath
		}
		// Also check in same directory as executable
		sameDirPath := filepath.Join(exeDir, "ossutil")
		if _, err := os.Stat(sameDirPath); err == nil {
			ossutilPath = sameDirPath
		}
	}

	// For development mode, check relative to working directory
	if ossutilPath == "ossutil" {
		cwd, err := os.Getwd()
		if err == nil {
			cwdBinPath := filepath.Join(cwd, "bin", "ossutil")
			if _, err := os.Stat(cwdBinPath); err == nil {
				ossutilPath = cwdBinPath
			}
		}
	}

	return &OSSService{
		ossutilPath:        ossutilPath,
		defaultOssutilPath: ossutilPath,
		defaultConfigDir:   defaultConfigDir,
		configDir:          configDir,
		transferLimiter:    newTransferLimiter(3),
	}
}

func ossutilStartFailed(err error) bool {
	if err == nil {
		return false
	}

	// If the process started but exited non-zero, it's a real ossutil error (no fallback).
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return false
	}

	// Failed to start (not found / permission / path issue) → try fallback.
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) || errors.Is(err, fs.ErrPermission)
}

func ossutilOutputOrError(err error, output []byte) string {
	msg := strings.TrimSpace(string(output))
	if msg != "" {
		return msg
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func firstHTTPURL(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		for _, field := range strings.Fields(line) {
			if strings.HasPrefix(field, "https://") || strings.HasPrefix(field, "http://") {
				return field
			}
		}
	}
	return ""
}

func (s *OSSService) runOssutil(args ...string) ([]byte, error) {
	primary := strings.TrimSpace(s.ossutilPath)
	fallback := strings.TrimSpace(s.defaultOssutilPath)

	if primary == "" {
		primary = fallback
	}
	if primary == "" {
		primary = "ossutil"
	}

	cmd := exec.Command(primary, args...)
	output, err := cmd.CombinedOutput()
	if err == nil || !ossutilStartFailed(err) || fallback == "" || fallback == primary {
		return output, err
	}

	// Retry with the auto-discovered ossutil path.
	fallbackCmd := exec.Command(fallback, args...)
	fallbackOutput, fallbackErr := fallbackCmd.CombinedOutput()
	if fallbackErr == nil || !ossutilStartFailed(fallbackErr) {
		// Stick to the working one for subsequent operations.
		s.ossutilPath = fallback
		return fallbackOutput, fallbackErr
	}

	return output, err
}

// SetOssutilPath sets custom ossutil binary path
func (s *OSSService) SetOssutilPath(path string) {
	if strings.TrimSpace(path) == "" {
		s.ossutilPath = s.defaultOssutilPath
		return
	}
	s.ossutilPath = path
}

// GetOssutilPath returns current ossutil path
func (s *OSSService) GetOssutilPath() string {
	return s.ossutilPath
}

func (s *OSSService) stateFilePathIn(dir string) string {
	return filepath.Join(dir, appStateFileName)
}

func (s *OSSService) legacySettingsPathIn(dir string) string {
	return filepath.Join(dir, legacySettingsName)
}

func (s *OSSService) legacyProfilesPathIn(dir string) string {
	return filepath.Join(dir, legacyProfilesName)
}

func (s *OSSService) workDirRefPath() string {
	return filepath.Join(s.defaultConfigDir, workDirRefFileName)
}

func (s *OSSService) applySettingsRuntime(settings AppSettings) {
	if strings.TrimSpace(settings.OssutilPath) == "" {
		s.ossutilPath = s.defaultOssutilPath
	} else {
		s.ossutilPath = settings.OssutilPath
	}
	s.setMaxTransferThreads(settings.MaxTransferThreads)
}

func (s *OSSService) writeWorkDirRef(workDir string) error {
	workDir = normalizeWorkDirPath(workDir, s.defaultConfigDir)
	if err := os.MkdirAll(s.defaultConfigDir, 0700); err != nil {
		return err
	}

	refPath := s.workDirRefPath()
	if workDir == s.defaultConfigDir {
		if err := os.Remove(refPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}

	ref := workDirRef{WorkDir: compactHomePath(workDir)}
	data, err := json.MarshalIndent(ref, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(refPath, data, 0600)
}

func (s *OSSService) saveAppStateToDir(dir string, state appState) error {
	dir = normalizeWorkDirPath(dir, s.defaultConfigDir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	state.SchemaVersion = appStateSchemaVersion
	state.Settings = normalizeAppSettings(state.Settings, dir)
	state.Settings.WorkDir = compactHomePath(dir)
	if state.Profiles == nil {
		state.Profiles = []OSSProfile{}
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.stateFilePathIn(dir), data, 0600)
}

func (s *OSSService) loadAppStateFromDir(dir string) (appState, error) {
	dir = normalizeWorkDirPath(dir, s.defaultConfigDir)
	state := appState{
		SchemaVersion: appStateSchemaVersion,
		Settings:      defaultAppSettings(dir),
		Profiles:      []OSSProfile{},
	}

	if data, err := os.ReadFile(s.stateFilePathIn(dir)); err == nil {
		if err := json.Unmarshal(data, &state); err != nil {
			return appState{}, err
		}
		state.Settings = normalizeAppSettings(state.Settings, dir)
		if state.Profiles == nil {
			state.Profiles = []OSSProfile{}
		}
		return state, nil
	} else if !os.IsNotExist(err) {
		return appState{}, err
	}

	migrated := false
	if data, err := os.ReadFile(s.legacySettingsPathIn(dir)); err == nil {
		if err := json.Unmarshal(data, &state.Settings); err != nil {
			return appState{}, err
		}
		migrated = true
	} else if !os.IsNotExist(err) {
		return appState{}, err
	}

	if data, err := os.ReadFile(s.legacyProfilesPathIn(dir)); err == nil {
		if err := json.Unmarshal(data, &state.Profiles); err != nil {
			return appState{}, err
		}
		migrated = true
	} else if !os.IsNotExist(err) {
		return appState{}, err
	}

	state.Settings = normalizeAppSettings(state.Settings, dir)
	if state.Profiles == nil {
		state.Profiles = []OSSProfile{}
	}

	if migrated {
		if err := s.saveAppStateToDir(dir, state); err != nil {
			return appState{}, err
		}
	}
	return state, nil
}

func (s *OSSService) loadAppState() (appState, error) {
	dir := normalizeWorkDirPath(s.configDir, s.defaultConfigDir)
	state, err := s.loadAppStateFromDir(dir)
	if err != nil {
		return appState{}, err
	}

	configuredDir := normalizeWorkDirPath(state.Settings.WorkDir, dir)
	if configuredDir != dir {
		state, err = s.loadAppStateFromDir(configuredDir)
		if err != nil {
			return appState{}, err
		}
		dir = configuredDir
	}

	s.configDir = dir
	return state, nil
}

func parseDefaultPathLocation(path string) (string, string, bool) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", "", false
	}

	trimmed = strings.TrimPrefix(trimmed, "oss://")
	trimmed = strings.TrimLeft(trimmed, "/")
	if trimmed == "" {
		return "", "", false
	}

	parts := strings.SplitN(trimmed, "/", 2)
	bucket := strings.TrimSpace(parts[0])
	bucket = strings.Trim(bucket, "/")
	if bucket == "" {
		return "", "", false
	}

	if len(parts) < 2 {
		return bucket, "", true
	}

	prefix := strings.TrimSpace(parts[1])
	prefix = strings.TrimLeft(prefix, "/")
	if prefix == "" {
		return bucket, "", true
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return bucket, prefix, true
}

// TestConnection tests the OSS connection with given config
func (s *OSSService) TestConnection(config OSSConfig) ConnectionResult {
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	defaultBucket, defaultPrefix, hasDefaultLocation := parseDefaultPathLocation(config.DefaultPath)
	if endpoint != "" && isAccessPointEndpoint(endpoint) && !hasDefaultLocation {
		return ConnectionResult{
			Success: false,
			Message: fmt.Sprintf(
				"Connection test failed: endpoint looks like an OSS Access Point (bucket-scoped), but listing buckets requires a service endpoint.\n"+
					"Please leave Endpoint empty or use something like: %s",
				suggestServiceEndpoint(region),
			),
		}
	}

	// Use SDK paged listing for a lightweight smoke test (avoid slow full ls on huge prefixes).
	if hasDefaultLocation {
		_, err := s.ListObjectsPage(config, defaultBucket, defaultPrefix, "", 1)
		if err != nil {
			return ConnectionResult{
				Success: false,
				Message: fmt.Sprintf("Connection failed: %s", err.Error()),
			}
		}

		return ConnectionResult{
			Success: true,
			Message: "Connection successful",
		}
	}

	if err := sdkSmokeTestListBuckets(config); err != nil {
		return ConnectionResult{
			Success: false,
			Message: fmt.Sprintf("Connection failed: %s", err.Error()),
		}
	}

	return ConnectionResult{Success: true, Message: "Connection successful"}
}

// SaveProfile saves an OSS profile to config directory
func (s *OSSService) SaveProfile(profile OSSProfile) error {
	state, err := s.loadAppState()
	if err != nil {
		return err
	}
	profiles := state.Profiles

	// Update or add profile
	found := false
	for i, p := range profiles {
		if p.Name == profile.Name {
			profiles[i] = profile
			found = true
			break
		}
	}
	if !found {
		profiles = append(profiles, profile)
	}

	// If this profile is default, unset others
	if profile.IsDefault {
		for i := range profiles {
			if profiles[i].Name != profile.Name {
				profiles[i].IsDefault = false
			}
		}
	}

	state.Profiles = profiles
	return s.saveAppStateToDir(s.configDir, state)
}

// LoadProfiles loads all saved profiles
func (s *OSSService) LoadProfiles() ([]OSSProfile, error) {
	state, err := s.loadAppState()
	if err != nil {
		return nil, err
	}
	if state.Profiles == nil {
		return []OSSProfile{}, nil
	}
	return state.Profiles, nil
}

// GetProfile loads a specific profile by name
func (s *OSSService) GetProfile(name string) (*OSSProfile, error) {
	state, err := s.loadAppState()
	if err != nil {
		return nil, err
	}

	for _, p := range state.Profiles {
		if p.Name == name {
			return &p, nil
		}
	}

	return nil, fmt.Errorf("profile not found: %s", name)
}

// DeleteProfile deletes a profile by name
func (s *OSSService) DeleteProfile(name string) error {
	state, err := s.loadAppState()
	if err != nil {
		return err
	}

	profiles := state.Profiles
	newProfiles := make([]OSSProfile, 0)
	for _, p := range profiles {
		if p.Name != name {
			newProfiles = append(newProfiles, p)
		}
	}

	state.Profiles = newProfiles
	return s.saveAppStateToDir(s.configDir, state)
}

// GetDefaultProfile returns the default profile if set
func (s *OSSService) GetDefaultProfile() (*OSSProfile, error) {
	state, err := s.loadAppState()
	if err != nil {
		return nil, err
	}

	for _, p := range state.Profiles {
		if p.IsDefault {
			return &p, nil
		}
	}

	return nil, nil
}

// ListBuckets lists all buckets for the given config
func (s *OSSService) ListBuckets(config OSSConfig) ([]BucketInfo, error) {
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	if endpoint != "" && isAccessPointEndpoint(endpoint) {
		return nil, fmt.Errorf(
			"failed to list buckets: Endpoint appears to be an OSS Access Point (bucket-scoped). Listing buckets must use a service endpoint. Leave Endpoint empty or set it to something like %s",
			suggestServiceEndpoint(region),
		)
	}

	args := []string{
		"ls",
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
	}

	// Make bucket output stable and easy to parse (one bucket per line: oss://bucket-name).
	args = append(args, "--short-format")

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list buckets: %s", ossutilOutputOrError(err, output))
	}

	return s.parseBucketList(string(output)), nil
}

// parseBucketList parses ossutil ls output to bucket list
func (s *OSSService) parseBucketList(output string) []BucketInfo {
	var buckets []BucketInfo
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "CreationTime") || strings.HasPrefix(line, "Bucket Number") {
			continue
		}

		// Support both short format (line starts with oss://) and long format (oss:// appears at the end).
		fields := strings.Fields(line)
		var bucketURL string
		for _, f := range fields {
			if strings.HasPrefix(f, "oss://") {
				bucketURL = f
				break
			}
		}
		if bucketURL == "" {
			continue
		}
		name := strings.TrimPrefix(bucketURL, "oss://")
		name = strings.Trim(name, "/")
		if name == "" {
			continue
		}
		buckets = append(buckets, BucketInfo{Name: name})
	}

	return buckets
}

// ListObjects lists objects in a bucket with optional prefix
func (s *OSSService) ListObjects(config OSSConfig, bucketName string, prefix string) ([]ObjectInfo, error) {
	bucketUrl := fmt.Sprintf("oss://%s/%s", bucketName, prefix)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	args := []string{
		"ls",
		bucketUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)

	if err != nil {
		return nil, fmt.Errorf("failed to list objects: %s", ossutilOutputOrError(err, output))
	}

	return s.parseObjectList(string(output), bucketName, prefix), nil
}

// parseObjectList parses ossutil ls output and simulates folder navigation
func (s *OSSService) parseObjectList(output string, bucketName string, prefix string) []ObjectInfo {
	var objects []ObjectInfo
	lines := strings.Split(output, "\n")
	seenFolders := make(map[string]bool)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Object Number") || strings.HasPrefix(line, "Total Size") {
			continue
		}

		// Parse file lines with metadata
		// Format: LastModifiedTime Size(B) StorageClass ETAG ObjectName
		// Example: 2023-01-01 12:00:00 1234567 Standard D41D8CD98F oss://bucket/path/file.mp4
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}

		objectPath := fields[len(fields)-1]
		if !strings.HasPrefix(objectPath, "oss://") {
			continue
		}

		// Extract full key relative to bucket
		fullKey := strings.TrimPrefix(objectPath, fmt.Sprintf("oss://%s/", bucketName))

		// Skip if this is before our prefix
		if !strings.HasPrefix(fullKey, prefix) && fullKey+"/" != prefix {
			continue
		}

		// Get the part after our prefix
		relativePath := strings.TrimPrefix(fullKey, prefix)
		if relativePath == "" {
			continue // Skip the prefix folder itself
		}

		// Check if this is a direct child or a nested item
		slashIdx := strings.Index(relativePath, "/")

		if slashIdx != -1 {
			// This is inside a subfolder - extract the folder name
			folderName := relativePath[:slashIdx]
			if folderName == "" {
				continue
			}

			// Only add folder once
			if !seenFolders[folderName] {
				seenFolders[folderName] = true
				objects = append(objects, ObjectInfo{
					Name: folderName,
					Path: fmt.Sprintf("oss://%s/%s%s/", bucketName, prefix, folderName),
					Type: "Folder",
				})
			}
		} else {
			// This is a direct child file
			// Parse metadata - find oss:// path position to determine field layout
			// Format may include timezone: 2023-01-01 12:00:00 +0800 1234567 Standard ETAG oss://...
			// Or without: 2023-01-01 12:00:00 1234567 Standard ETAG oss://...
			ossPathIdx := len(fields) - 1

			var size int64
			var lastModified, storageClass string

			// Work backwards from oss:// path
			// fields[ossPathIdx] = oss://path
			// fields[ossPathIdx-1] = ETAG
			// fields[ossPathIdx-2] = StorageClass
			// fields[ossPathIdx-3] = Size
			if ossPathIdx >= 4 {
				fmt.Sscanf(fields[ossPathIdx-3], "%d", &size)
				storageClass = fields[ossPathIdx-2]
			}

			// Date and time are always the first two fields
			if len(fields) >= 2 {
				lastModified = fields[0] + " " + fields[1]
			}

			objects = append(objects, ObjectInfo{
				Name:         relativePath,
				Path:         objectPath,
				Size:         size,
				Type:         "File",
				LastModified: lastModified,
				StorageClass: storageClass,
			})
		}
	}

	return objects
}

// DownloadFile downloads a file from OSS
func (s *OSSService) DownloadFile(config OSSConfig, bucket string, object string, localPath string) error {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	args := []string{
		"cp",
		cloudUrl,
		localPath,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
		"-f", // Force overwrite
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)

	if err != nil {
		return fmt.Errorf("download failed: %s", ossutilOutputOrError(err, output))
	}

	return nil
}

// UploadFile uploads a file to OSS
func (s *OSSService) UploadFile(config OSSConfig, bucket string, prefix string, localPath string) error {
	fileName := filepath.Base(localPath)
	cloudUrl := fmt.Sprintf("oss://%s/%s%s", bucket, prefix, fileName)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	args := []string{
		"cp",
		localPath,
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
		"-f", // Force overwrite
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)

	if err != nil {
		return fmt.Errorf("upload failed: %s", ossutilOutputOrError(err, output))
	}

	return nil
}

// DeleteObject deletes an object from OSS
func (s *OSSService) DeleteObject(config OSSConfig, bucket string, object string) error {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	args := []string{
		"rm",
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
		"-f", // Force delete without confirmation prompt (since we handle it in UI)
	}

	// recursive delete if it looks like a directory (though in OSS directories are fake, ossutil -r helps for common prefixes)
	if strings.HasSuffix(object, "/") {
		args = append(args, "-r")
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)

	if err != nil {
		return fmt.Errorf("delete failed: %s", ossutilOutputOrError(err, output))
	}

	return nil
}

func (s *OSSService) PresignObject(config OSSConfig, bucket string, object string, expiresDuration string) (string, error) {
	bucket = strings.TrimSpace(bucket)
	object = strings.TrimLeft(strings.TrimSpace(object), "/")

	if bucket == "" {
		return "", fmt.Errorf("bucket name is required")
	}
	if object == "" {
		return "", fmt.Errorf("object key is required")
	}

	expiresDuration = strings.TrimSpace(expiresDuration)
	if expiresDuration == "" {
		expiresDuration = "15m"
	}

	expires, err := time.ParseDuration(expiresDuration)
	if err != nil {
		return "", fmt.Errorf("invalid expires duration: %w", err)
	}
	if expires < 0 {
		return "", fmt.Errorf("invalid expires duration: must be non-negative")
	}

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return "", err
	}
	bkt, err := client.Bucket(bucket)
	if err != nil {
		return "", fmt.Errorf("failed to open bucket: %w", err)
	}

	timeoutSeconds := int64(expires.Seconds())
	signedURL, err := bkt.SignURL(object, oss.HTTPGet, timeoutSeconds)
	if err != nil {
		return "", fmt.Errorf("presign failed: %w", err)
	}

	parts := strings.SplitN(signedURL, "?", 2)
	parts[0] = strings.ReplaceAll(parts[0], "%2F", "/")
	if len(parts) == 2 {
		return parts[0] + "?" + parts[1], nil
	}
	return parts[0], nil
}

func (s *OSSService) GetObjectText(config OSSConfig, bucket string, object string, maxBytes int) (string, error) {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	if maxBytes <= 0 {
		maxBytes = 256 * 1024
	}
	if maxBytes > 5*1024*1024 {
		maxBytes = 5 * 1024 * 1024
	}

	args := []string{
		"cat",
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
		"--count", strconv.Itoa(maxBytes),
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	runSplit := func(bin string, args ...string) ([]byte, []byte, error) {
		cmd := exec.Command(bin, args...)
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		return stdout.Bytes(), stderr.Bytes(), err
	}

	primary := strings.TrimSpace(s.ossutilPath)
	fallback := strings.TrimSpace(s.defaultOssutilPath)
	if primary == "" {
		primary = fallback
	}
	if primary == "" {
		primary = "ossutil"
	}

	stdout, stderr, err := runSplit(primary, args...)
	if err != nil && ossutilStartFailed(err) && fallback != "" && fallback != primary {
		// Retry with the auto-discovered ossutil path.
		fallbackStdout, fallbackStderr, fallbackErr := runSplit(fallback, args...)
		if fallbackErr == nil || !ossutilStartFailed(fallbackErr) {
			s.ossutilPath = fallback
			stdout, stderr, err = fallbackStdout, fallbackStderr, fallbackErr
		}
	}

	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(stdout))
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("read object failed: %s", msg)
	}

	return stripOssutilElapsedFooter(string(stdout)), nil
}

func stripOssutilElapsedFooter(output string) string {
	trimmed := strings.TrimRight(output, "\r\n")
	if trimmed == "" {
		return output
	}

	lastNewline := strings.LastIndex(trimmed, "\n")
	if lastNewline == -1 {
		if isOssutilElapsedFooterLine(strings.TrimSpace(trimmed)) {
			return ""
		}
		return output
	}

	lastLine := strings.TrimSpace(strings.TrimSuffix(trimmed[lastNewline+1:], "\r"))
	if !isOssutilElapsedFooterLine(lastLine) {
		return output
	}

	return trimmed[:lastNewline+1]
}

func isOssutilElapsedFooterLine(line string) bool {
	const suffix = "(s) elapsed"
	if !strings.HasSuffix(line, suffix) {
		return false
	}

	num := strings.TrimSpace(strings.TrimSuffix(line, suffix))
	if num == "" {
		return false
	}

	_, err := strconv.ParseFloat(num, 64)
	return err == nil
}

func (s *OSSService) PutObjectText(config OSSConfig, bucket string, object string, content string) error {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	tmpFile, err := os.CreateTemp("", "walioss-edit-*")
	if err != nil {
		return fmt.Errorf("create temp file failed: %w", err)
	}
	defer func() {
		_ = os.Remove(tmpFile.Name())
	}()

	if _, err := tmpFile.WriteString(content); err != nil {
		_ = tmpFile.Close()
		return fmt.Errorf("write temp file failed: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close temp file failed: %w", err)
	}

	args := []string{
		"cp",
		tmpFile.Name(),
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", region,
		"-f",
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	output, err := s.runOssutil(args...)
	if err != nil {
		return fmt.Errorf("save failed: %s", ossutilOutputOrError(err, output))
	}

	return nil
}

// CheckOssutilInstalled checks if ossutil is installed and accessible
func (s *OSSService) CheckOssutilInstalled() ConnectionResult {
	output, err := s.runOssutil("version")

	if err != nil {
		return ConnectionResult{
			Success: false,
			Message: fmt.Sprintf("ossutil not found or not accessible: %s", err.Error()),
		}
	}

	return ConnectionResult{
		Success: true,
		Message: strings.TrimSpace(string(output)),
	}
}

// saveProfiles saves profiles to config file
func (s *OSSService) saveProfiles(profiles []OSSProfile) error {
	state, err := s.loadAppState()
	if err != nil {
		return err
	}
	state.Profiles = profiles
	return s.saveAppStateToDir(s.configDir, state)
}

// GetSettings loads application settings
func (s *OSSService) GetSettings() (AppSettings, error) {
	state, err := s.loadAppState()
	if err != nil {
		return AppSettings{}, err
	}

	settings := normalizeAppSettings(state.Settings, s.configDir)
	settings.WorkDir = compactHomePath(s.configDir)
	state.Settings = settings
	_ = s.saveAppStateToDir(s.configDir, state)
	_ = s.writeWorkDirRef(s.configDir)

	s.applySettingsRuntime(settings)
	return settings, nil
}

// SaveSettings persists application settings
func (s *OSSService) SaveSettings(settings AppSettings) error {
	state, err := s.loadAppState()
	if err != nil {
		return err
	}

	nextSettings := normalizeAppSettings(settings, s.defaultConfigDir)
	targetDir := nextSettings.WorkDir
	state.Settings = nextSettings

	if err := s.saveAppStateToDir(targetDir, state); err != nil {
		return err
	}
	s.configDir = targetDir
	if err := s.writeWorkDirRef(targetDir); err != nil {
		return err
	}

	s.applySettingsRuntime(nextSettings)
	return nil
}
