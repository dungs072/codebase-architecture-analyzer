using System.Collections.Generic;

namespace Game.Core
{
    public interface IInventoryService
    {
        bool RemoveSeed(string cropId);
        void AddItem(string id, int count);
    }

    public class InventoryService : IInventoryService
    {
        private readonly Dictionary<string, int> _items = new();

        public bool RemoveSeed(string cropId)
        {
            if (!_items.TryGetValue(cropId, out var c) || c <= 0) return false;
            _items[cropId] = c - 1;
            return true;
        }

        public void AddItem(string id, int count)
        {
            _items[id] = (_items.TryGetValue(id, out var c) ? c : 0) + count;
        }
    }

    public class CurrencyService
    {
        public int Money { get; private set; } = 100;

        public bool TrySpend(int amount)
        {
            if (Money < amount) return false;
            Money -= amount;
            return true;
        }
    }

    public class UnusedHelper
    {
        public int Twice(int x) => x * 2;
    }
}
