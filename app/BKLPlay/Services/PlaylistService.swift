import Foundation

final class PlaylistService {
    static let shared = PlaylistService()
    private init() {}

    let mainPlaylistURL = "https://raw.githubusercontent.com/natajrak/IPTV-Playlist/mainhttps://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/playlist/main.txt"

    func fetch(_ urlString: String) async throws -> PlaylistNode {
        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(PlaylistNode.self, from: data)
    }
}
