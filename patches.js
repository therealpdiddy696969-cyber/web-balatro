window.patches = {
  "web_patches.lua": `-- Other patches not in this file:
-- globals.lua: F_SOUND_THREAD = false
-- game.lua: SOUND_MANAGER stub
-- main.lua: OS check removed, web_patches injected

-- Fake thread system so love.thread calls don't crash
local prevthread
local FakeThread = {}
FakeThread.__index = FakeThread

function FakeThread:new(thread)
    local o = setmetatable({}, FakeThread)
    o.thread = thread
    return o
end

function FakeThread:start(...)
    local args = {...}
    coroutine.wrap(function() self.thread(...) end)()
end

local FakeChannel = {}
FakeChannel.__index = FakeChannel

function FakeChannel:new(name)
    local o = setmetatable({}, FakeChannel)
    o.name = name
    o.queue = {}
    return o
end

function FakeChannel:push(value)
    print("Pushing value to channel: \t" .. self.name .. " - " .. tostring(value))
    table.insert(self.queue, value)
end

function FakeChannel:pop()
    print("Popping value from channel - " .. self.name)
    return table.remove(self.queue, 1)
end

function FakeChannel:demand()
    print("Popping value from channel - " .. self.name)
    while #self.queue == 0 do end
    return table.remove(self.queue, 1)
end

local channels = {}
local _newThread = love.thread.newThread
love.thread.newThread = function(thread)
    if type(thread) == "string" then
        local fn, err = loadstring(thread)
        if fn then thread = fn else print("Thread compile error: " .. tostring(err)) end
    end
    prevthread = FakeThread:new(thread)
    return prevthread
end

love.thread.getChannel = function(name)
    if not channels[name] then
        channels[name] = FakeChannel:new(name)
    end
    return channels[name]
end

-- Fix Log
local _log = math.log
math.log = function(x, base)
  if base then
    return _log(x) / _log(base)
  end
  return _log(x)
end

-- Patch load for smods
-- btw, mod support is pretty nonexistent
load = loadstring

-- Stub love.audio.newSource to prevent WebAudio crashes
local _newSource = love.audio.newSource
love.audio.newSource = function(...)
    local ok, src = pcall(_newSource, ...)
    if ok and src then return src end
    return setmetatable({}, {__index = function() return function() end end})
end

-- Stub love.audio.stop to prevent crashes when stopping invalid sources
local _audioStop = love.audio.stop
love.audio.stop = function(...)
    local ok, err = pcall(_audioStop, ...)
    if not ok then print("audio.stop error (ignored): " .. tostring(err)) end
end`,
// -------------------------------------------------------------------------------
  "nativefs.lua": `-- faknativefs.lua
local nativefs = {}

function join_path(a, b)
    -- If b is absolute (starts with /), return b as-is only if a is empty
    if b:find("^/") and a == "" then return b end
    -- Strip leading slashes from b to avoid double-slash issues
    b = b:gsub("^/+", "")
    if a == "" then return b end
    if not a:find("/$") then a = a .. "/" end
    return (a .. b):gsub("//+", "/")
end

nativefs.workingDirectory = ""

-- Read a file from the game's source or save directory
function nativefs.read(filename)
    local fullpath = join_path(nativefs.workingDirectory, filename)
    -- Try full path first
    local ok, result = pcall(love.filesystem.read, fullpath)
    if ok and result then return result end
    -- Try filename directly
    ok, result = pcall(love.filesystem.read, filename)
    if ok and result then return result end
    return nil, "File does not exist: " .. tostring(fullpath)
end

function nativefs.write(filename, data)
    return love.filesystem.write(join_path(nativefs.workingDirectory, filename), data)
end

function nativefs.append(filename, data)
    return love.filesystem.append(join_path(nativefs.workingDirectory, filename), data)
end

-- Check if a path exists and get info
function nativefs.getInfo(path)
    local fullpath = join_path(nativefs.workingDirectory, path)
    -- Try as directory first
    local children = love.filesystem.getDirectoryItems(fullpath)
    if children then
        return { type = "directory", size = 0, modtime = 0 }
    end
    -- Try as file
    local ok, info = pcall(love.filesystem.getInfo, fullpath)
    if ok and info then
        info.type = "file"
        return info
    end
    return nil
end

function nativefs.getDirectoryItems(path)
    return love.filesystem.getDirectoryItems(join_path(nativefs.workingDirectory, path))
end

function nativefs.getDirectoryItemsInfo(path)
    local fullpath = join_path(nativefs.workingDirectory, path)
    local files = love.filesystem.getDirectoryItems(fullpath)
    local out = {}
    for i, v in ipairs(files) do
        local itempath = join_path(fullpath, v)
        -- Determine type by trying to list as directory
        local children = love.filesystem.getDirectoryItems(itempath)
        local t = (children ~= nil) and "directory" or "file"
        out[#out+1] = { name = v, type = t, size = 0, modtime = 0 }
    end
    return out
end

function nativefs.setWorkingDirectory(path)
    -- If path is absolute or starts with a known absolute prefix, reset working dir
    if path:find("^/") or path:find("^[A-Za-z]:") then
        nativefs.workingDirectory = ""
        print("Navigated to / (absolute path reset)")
    else
        nativefs.workingDirectory = join_path(nativefs.workingDirectory, path)
        print("Navigated to " .. nativefs.workingDirectory)
    end
end

function nativefs.getWorkingDirectory()
    return nativefs.workingDirectory
end

function nativefs.createDirectory(path)
    return love.filesystem.createDirectory(join_path(nativefs.workingDirectory, path))
end

function nativefs.remove(path)
    return love.filesystem.remove(join_path(nativefs.workingDirectory, path))
end

function nativefs.load(filename)
    local contents, err = nativefs.read(filename)
    if not contents then return nil, err end
    local fn, err2 = loadstring(contents, filename)
    if not fn then return nil, err2 end
    return fn
end

function nativefs.lines(filename)
    local contents = nativefs.read(filename)
    if not contents then return function() return nil end end
    local lines = {}
    for line in contents:gmatch("([^\n]*)\n?") do
        table.insert(lines, line)
    end
    local i = 0
    return function()
        i = i + 1
        return lines[i]
    end
end

function nativefs.mount(path, mountPoint, appendToPath)
    return true
end

function nativefs.unmount(path)
    return true
end

function nativefs.newFile(path)
    return { path = path }
end

return nativefs`,
// -------------------------------------------------------------------------------
  "lovely.lua": `-- lovely stub for web build
local lovely = {}

lovely.version = "1.0.0-WEB"
lovely.mod_dir = "Mods"

-- noop patches
function lovely.add_patch() end
function lovely.remove_patch() end
function lovely.get_patch() return nil end
function lovely.list_patches() return {} end
function lovely.remove_var() end
function lovely.set_var() end
function lovely.get_var() return nil end
function lovely.reload_patches() end

function lovely.apply_patches(path, source)
    print("apply_patches loading: " .. tostring(path))
    -- source is already provided as second arg — use it directly if available
    if source then
        print("apply_patches: using provided source for " .. tostring(path) .. " (" .. #source .. " bytes)")
        return source
    end
    local function try_read(p)
        local ok, result = pcall(love.filesystem.read, p)
        if ok and result then return result end
        return nil
    end
    local tries = {
        path,
        "resources/shaders/" .. path,
        "resources/" .. path,
    }
    for _, p in ipairs(tries) do
        local contents = try_read(p)
        if contents then
            print("apply_patches: got contents for " .. p .. " (" .. #contents .. " bytes)")
            return contents
        end
    end
    print("apply_patches: NOT FOUND, using passthrough for " .. tostring(path))
    return [[
        #ifdef VERTEX
        vec4 position(mat4 transform_projection, vec4 vertex_position) {
            return transform_projection * vertex_position;
        }
        #endif
        #ifdef PIXEL
        vec4 effect(vec4 color, Image texture, vec2 texture_coords, vec2 screen_coords) {
            return Texel(texture, texture_coords) * color;
        }
        #endif
    ]]
end

-- Stub love.graphics.newImage to handle missing config
local _newImage = love.graphics.newImage
love.graphics.newImage = function(path, config)
    config = config or {}
    return _newImage(path, config)
end

-- Stub love.window functions
love.window.setFullscreen = function() return true end
love.window.setMode = function(w, h, flags)
    if flags then flags.fullscreen = false end
    return true
end

return lovely`,
// -------------------------------------------------------------------------------
}

// Bit library for Lua 5.1 compat
window.patches["bit.lua"] = `-- bit library stub
local M = {}
local MOD = 2^32

local function bit_tobit(x)
  x = x % MOD
  if x >= 0x80000000 then return x - MOD end
  return x
end

function M.tobit(x) return bit_tobit(x) end
function M.tohex(x, ...) return ("%08x"):format(x % MOD) end
function M.bnot(x) return bit_tobit((-1-x) % MOD) end

local function bit_bor(a, b, c, ...)
  if c then return bit_bor(bit_bor(a, b), c, ...)
  elseif b then return bit_tobit((a % MOD) | (b % MOD))
  else return bit_tobit(a) end
end
M.bor = bit_bor

local function bit_band(a, b, c, ...)
  if c then return bit_band(bit_band(a, b), c, ...)
  elseif b then return bit_tobit((a % MOD) & (b % MOD))
  else return bit_tobit(a) end
end
M.band = bit_band

local function bit_bxor(a, b, c, ...)
  if c then return bit_bxor(bit_bxor(a, b), c, ...)
  elseif b then return bit_tobit((a % MOD) ~ (b % MOD))
  else return bit_tobit(a) end
end
M.bxor = bit_bxor

function M.lshift(x, n) return bit_tobit((x * 2^n) % MOD) end
function M.rshift(x, n) return math.floor((x % MOD) / 2^n) end
function M.arshift(x, n)
  x = x % MOD
  if x >= 0x80000000 then x = x - MOD end
  return bit_tobit(math.floor(x / 2^n))
end
function M.rol(x, n)
  n = n % 32
  return M.bor(M.lshift(x, n), M.rshift(x, 32-n))
end
function M.ror(x, n) return M.rol(x, 32-n) end
function M.bswap(x)
  x = x % MOD
  local b0 = x & 0xFF
  local b1 = (x >> 8) & 0xFF
  local b2 = (x >> 16) & 0xFF
  local b3 = (x >> 24) & 0xFF
  return bit_tobit(b0 << 24 | b1 << 16 | b2 << 8 | b3)
end

return M`
