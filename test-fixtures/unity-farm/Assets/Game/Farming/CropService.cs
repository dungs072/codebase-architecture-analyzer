using Game.Core;
using Game.UI;

namespace Game.Farming
{
    public abstract class GameAction
    {
        public abstract void Execute();
    }

    public class Plot
    {
        public string CropId;
        public float PlantedAt;
        public bool IsEmpty => string.IsNullOrEmpty(CropId);
    }

    public class CropService
    {
        private readonly IInventoryService _inventory;
        private readonly ITimeService _time;
        private FarmScreen _debugScreen; // layer violation on purpose

        public CropService(IInventoryService inventory, ITimeService time)
        {
            _inventory = inventory;
            _time = time;
        }

        public bool Plant(Plot plot, string cropId)
        {
            if (!plot.IsEmpty) return false;
            if (!_inventory.RemoveSeed(cropId)) return false;
            plot.CropId = cropId;
            plot.PlantedAt = _time.Now;
            _debugScreen.ShowGrowth(0);
            return true;
        }

        public void Harvest(Plot plot)
        {
            _inventory.AddItem(plot.CropId, 2);
            plot.CropId = null;
        }
    }
}
