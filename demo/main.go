// Local Kimodo text-to-motion demo. Generation is serialized so one native
// process owns Vulkan at a time, while the persistent gallery stays readable.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed index.html
var files embed.FS

//go:embed models.js
var modelUI []byte

//go:embed assets/localai.png
var localAILogo []byte

//go:embed assets
var assetFiles embed.FS

type animation struct {
	ID             string `json:"id"`
	Prompt         string `json:"prompt"`
	Frames         int    `json:"frames"`
	DiffusionSteps int    `json:"diffusion_steps"`
	Seed           uint64 `json:"seed"`
	CreatedAt      string `json:"created_at"`
	Status         string `json:"status"`
	Error          string `json:"error,omitempty"`
	Kind           string `json:"kind"`
	Model          string `json:"model"`
}
type motionModel struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Skeleton  string `json:"skeleton"`
	Upstream  string `json:"upstream"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Motion    string `json:"-"`
}
type gallery struct {
	mu                      sync.RWMutex
	items                   map[string]*animation
	output                  string
	queue                   chan string
	generator, motion, text string
	models                  map[string]motionModel
}

func token() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func (g *gallery) save(a *animation) error {
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(g.output, a.ID+".json"), b, 0644)
}
func (g *gallery) list() []*animation {
	g.mu.RLock()
	defer g.mu.RUnlock()
	result := make([]*animation, 0, len(g.items))
	for _, item := range g.items {
		copy := *item
		result = append(result, &copy)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt > result[j].CreatedAt })
	return result
}
func (g *gallery) worker() {
	for id := range g.queue {
		g.mu.Lock()
		item := g.items[id]
		item.Status = "running"
		_ = g.save(item)
		g.mu.Unlock()
		dir := filepath.Join(g.output, id)
		err := os.MkdirAll(dir, 0755)
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, "prompt.txt"), []byte(item.Prompt), 0600)
		}
		if err == nil {
			model, ok := g.models[item.Model]
			if !ok || !model.Available {
				err = fmt.Errorf("model %q is not available", item.Model)
			} else {
				cmd := exec.Command(g.generator, model.Motion, g.text, filepath.Join(dir, "prompt.txt"), fmt.Sprint(item.Frames), fmt.Sprint(item.DiffusionSteps), fmt.Sprint(item.Seed), dir)
				cmd.Env = append(os.Environ(), "KIMODO_BACKEND=vulkan")
				output, runErr := cmd.CombinedOutput()
				if runErr != nil {
					err = fmt.Errorf("%w: %s", runErr, strings.TrimSpace(string(output)))
				}
			}
		}
		g.mu.Lock()
		if err != nil {
			item.Status = "failed"
			item.Error = err.Error()
		} else {
			item.Status = "ready"
		}
		if saveErr := g.save(item); saveErr != nil {
			log.Printf("save %s: %v", item.ID, saveErr)
		}
		g.mu.Unlock()
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8090", "listen address")
	motion := flag.String("motion-model", "models/kimodo-smplx-rp-v1-f32.gguf", "motion GGUF")
	text := flag.String("text-bundle", "generated/llm2vec-text-bundle", "native LLM2Vec component directory")
	generator := flag.String("generator", "build/debug/kmd-generate", "native text-to-motion command")
	output := flag.String("output", "demo-output", "persistent gallery directory")
	flag.Parse()
	if err := os.MkdirAll(*output, 0755); err != nil {
		log.Fatal(err)
	}
	models := map[string]motionModel{
		"smplx-rp-v1":    {ID: "smplx-rp-v1", Label: "SMPL-X RP v1", Skeleton: "SMPL-X 22 joints", Upstream: "nvidia/Kimodo-SMPLX-RP-v1", Available: true, Motion: *motion},
		"soma-rp-v1.1":   {ID: "soma-rp-v1.1", Label: "SOMA RP v1.1", Skeleton: "SOMA 30 joints", Upstream: "nvidia/Kimodo-SOMA-RP-v1.1", Reason: "SOMA decoder and GGML conversion are being added"},
		"soma-seed-v1.1": {ID: "soma-seed-v1.1", Label: "SOMA SEED v1.1", Skeleton: "SOMA 30 joints", Upstream: "nvidia/Kimodo-SOMA-SEED-v1.1", Reason: "SOMA decoder and GGML conversion are being added"},
		"g1-rp-v1":       {ID: "g1-rp-v1", Label: "G1 RP v1", Skeleton: "Unitree G1 34 joints", Upstream: "nvidia/Kimodo-G1-RP-v1", Reason: "G1 decoder and GGML conversion are being added"},
		"g1-seed-v1":     {ID: "g1-seed-v1", Label: "G1 SEED v1", Skeleton: "Unitree G1 34 joints", Upstream: "nvidia/Kimodo-G1-SEED-v1", Reason: "G1 decoder and GGML conversion are being added"},
	}
	g := &gallery{items: map[string]*animation{}, output: *output, queue: make(chan string, 32), generator: *generator, motion: *motion, text: *text, models: models}
	entries, _ := filepath.Glob(filepath.Join(*output, "*.json"))
	for _, path := range entries {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var a animation
		if json.Unmarshal(b, &a) == nil {
			g.items[a.ID] = &a
		}
	}
	go g.worker()
	index, err := files.ReadFile("index.html")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})
	mux.HandleFunc("/localai.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(localAILogo)
	})
	mux.HandleFunc("/models.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(modelUI)
	})
	mux.Handle("/assets/", http.FileServer(http.FS(assetFiles)))
	mux.HandleFunc("/api/animations", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g.list())
	})
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		result := make([]motionModel, 0, len(g.models))
		for _, model := range g.models {
			result = append(result, model)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		var request struct {
			Prompt string `json:"prompt"`
			Frames int    `json:"frames"`
			Steps  int    `json:"steps"`
			Seed   uint64 `json:"seed"`
			Model  string `json:"model"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&request); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		request.Prompt = strings.TrimSpace(request.Prompt)
		if request.Prompt == "" || len(request.Prompt) > 4096 {
			http.Error(w, "prompt must be 1..4096 bytes", 400)
			return
		}
		if request.Frames == 0 {
			request.Frames = 150
		}
		if request.Steps == 0 {
			request.Steps = 100
		}
		if request.Frames < 1 || request.Frames > 1000 || request.Steps < 1 || request.Steps > 1000 {
			http.Error(w, "frames and steps must be 1..1000", 400)
			return
		}
		if request.Model == "" {
			request.Model = "smplx-rp-v1"
		}
		model, ok := g.models[request.Model]
		if !ok || !model.Available {
			http.Error(w, "selected motion model is not available: "+model.Reason, http.StatusConflict)
			return
		}
		a := &animation{ID: token(), Prompt: request.Prompt, Frames: request.Frames, DiffusionSteps: request.Steps, Seed: request.Seed, CreatedAt: time.Now().UTC().Format(time.RFC3339), Status: "queued", Kind: "generated", Model: request.Model}
		g.mu.Lock()
		g.items[a.ID] = a
		err := g.save(a)
		g.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		g.queue <- a.ID
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(a)
	})
	mux.HandleFunc("/api/animations/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/animations/"), "/")
		if len(parts) != 2 || (parts[1] != "root.f32" && parts[1] != "rotations.f32") {
			http.NotFound(w, r)
			return
		}
		g.mu.RLock()
		a := g.items[parts[0]]
		g.mu.RUnlock()
		if a == nil || a.Status != "ready" {
			http.NotFound(w, r)
			return
		}
		name := "root_positions.f32"
		if parts[1] == "rotations.f32" {
			name = "local_rotations_xyzw.f32"
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, filepath.Join(g.output, a.ID, name))
	})
	log.Printf("Kimodo text-to-motion demo listening at http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
